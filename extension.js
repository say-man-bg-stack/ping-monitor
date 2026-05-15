import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export default class HierarchyPingMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._hostsStatus = {};
        this._menuItems = {};

        // Създаване на основния индикатор в панела
        this._indicator = new PanelMenu.Button(0.5, 'Hierarchy Ping Monitor', false);
        
        // Пазим референция към иконата, за да я сменяме динамично
        this._icon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon'
        });
        this._indicator.add_child(this._icon);
        Main.panel.addToStatusArea('hierarchy-ping-monitor', this._indicator);

        // Зареждане на структурата и изграждане на UI менюто
        this._reloadConfiguration();

        // Абониране за промени в настройките
        this._settingsSignals = [];
        this._settingsSignals.push(this._settings.connect('changed::hosts-json', () => this._reloadConfiguration()));
        this._settingsSignals.push(this._settings.connect('changed::interval-seconds', () => this._resetTimer()));
        this._settingsSignals.push(this._settings.connect('changed::ping-count', () => this._resetTimer()));

        this._startTimer();
    }

    disable() {
        this._stopTimer();

        if (this._settingsSignals) {
            this._settingsSignals.forEach(id => this._settings.disconnect(id));
            this._settingsSignals = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._icon = null;
        this._settings = null;
        this._hostsStatus = null;
        this._menuItems = null;
    }

    _reloadConfiguration() {
        this._indicator.menu.removeAll();
        this._menuItems = {};

        let hostsStr = this._settings.get_string('hosts-json');
        try {
            this._hosts = JSON.parse(hostsStr);
        } catch (e) {
            this._hosts = [];
        }

        this._hosts.forEach(h => {
            if (!this._hostsStatus[h.id]) {
                this._hostsStatus[h.id] = { status: 'UNKNOWN' };
            }
            
            let item = new PopupMenu.PopupMenuItem(`${h.name} (${h.address}): UNKNOWN`);
            this._indicator.menu.addMenuItem(item);
            this._menuItems[h.id] = item;
        });

        this._checkAllHosts();
    }

    _startTimer() {
        let interval = this._settings.get_int('interval-seconds');
        if (interval < 5) interval = 5;

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._checkAllHosts();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _resetTimer() {
        this._stopTimer();
        this._startTimer();
        this._checkAllHosts();
    }

    async _checkAllHosts() {
        if (!this._hosts || this._hosts.length === 0) {
            this._updatePanelIcon('UNKNOWN');
            return;
        }

        let pingCount = this._settings.get_int('ping-count').toString();

        let promises = this._hosts.map(async (host) => {
            let isUp = await this._pingAddress(host.address, pingCount);
            return { id: host.id, isUp };
        });

        let results = await Promise.all(promises);
        let pingResults = {};
        results.forEach(r => pingResults[r.id] = r.isUp);

        // Променливи за следене на глобалното състояние на иконата
        let hasDownHost = false;
        let hasUnknownHost = false;

        this._hosts.forEach(host => {
            let physicalUp = pingResults[host.id];
            let parentId = host.parent;
            let currentRecord = this._hostsStatus[host.id] || { status: 'UNKNOWN' };
            let oldStatus = currentRecord.status;
            let newStatus = 'UNKNOWN';

            if (!parentId) {
                newStatus = physicalUp ? 'UP' : 'DOWN';
            } else {
                let parentRecord = this._hostsStatus[parentId];
                let parentStatus = parentRecord ? parentRecord.status : 'UNKNOWN';

                if (parentStatus === 'DOWN' || parentStatus === 'UNKNOWN') {
                    newStatus = 'UNKNOWN'; 
                } else {
                    newStatus = physicalUp ? 'UP' : 'DOWN';
                }
            }

            currentRecord.status = newStatus;
            this._hostsStatus[host.id] = currentRecord;

            // Броене на състоянията за иконата
            if (newStatus === 'DOWN') hasDownHost = true;
            if (newStatus === 'UNKNOWN') hasUnknownHost = true;

            if (newStatus === 'DOWN' && oldStatus !== 'DOWN') {
                this._notifyHostDown(host);
            }

            if (this._menuItems[host.id]) {
                let statusEmoji = newStatus === 'UP' ? '🟢 UP' : (newStatus === 'DOWN' ? '🔴 DOWN' : '⚪ UNKNOWN');
                this._menuItems[host.id].label.set_text(`${host.name} (${host.address}): ${statusEmoji}`);
            }
        });

        // Определяне на финалното състояние на главната икона
        if (hasDownHost) {
            this._updatePanelIcon('DOWN');
        } else if (hasUnknownHost) {
            this._updatePanelIcon('UNKNOWN');
        } else {
            this._updatePanelIcon('UP');
        }
    }

    _pingAddress(address, count) {
        return new Promise((resolve) => {
            try {
                let commandString = `ping -c ${count} -W 2 ${address} > /dev/null 2>&1`;

                let proc = new Gio.Subprocess({
                    argv: ['sh', '-c', commandString],
                    flags: Gio.SubprocessFlags.NONE
                });

                proc.init(null);
                proc.wait_async(null, (obj, res) => {
                    try {
                        obj.wait_finish(res);
                        if (obj.get_if_exited()) {
                            resolve(obj.get_exit_status() === 0);
                        } else {
                            resolve(false);
                        }
                    } catch (e) {
                        resolve(false);
                    }
                });
            } catch (e) {
                resolve(false);
            }
        });
    }

    // Метод за динамична промяна на иконата и нейния стил
    _updatePanelIcon(globalStatus) {
        if (!this._icon) return;

        if (globalStatus === 'DOWN') {
            this._icon.icon_name = 'network-error-symbolic';
            // Използваме вградения CSS клас за критична грешка в GNOME Shell
            this._icon.set_style_class_name('system-status-icon');
            this._icon.set_style('color: #ed333b;'); // Наситено червен цвят от палитрата на GNOME
        } else if (globalStatus === 'UNKNOWN') {
            this._icon.icon_name = 'dialog-question-symbolic';
            this._icon.set_style_class_name('system-status-icon');
            this._icon.set_style('color: #9a9996;'); // Сив цвят (заглушено състояние)
        } else {
            this._icon.icon_name = 'network-transmit-receive-symbolic';
            this._icon.set_style_class_name('system-status-icon');
            this._icon.set_style(''); // Изчистване на стила (връщане към цвета на темата)
        }
    }

    _notifyHostDown(host) {
        Main.notify(
            `Връзката прекъсна: ${host.name}`,
            `Хост ${host.address} не отговаря, но инфраструктурата преди него е активна.`
        );
    }
}
