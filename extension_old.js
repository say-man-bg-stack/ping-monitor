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
        let icon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon'
        });
        this._indicator.add_child(icon);
        Main.panel.addToStatusArea('hierarchy-ping-monitor', this._indicator);

        // Зареждане на структурата и изграждане на UI менюто
        this._reloadConfiguration();

        // Абониране за промени в настройките от прозореца Preferences
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

        this._settings = null;
        this._hostsStatus = null;
        this._menuItems = null;
    }

    _reloadConfiguration() {
        // Изчистване на старото съдържание в менюто на панела
        this._indicator.menu.removeAll();
        this._menuItems = {};

        // Зареждане на списъка от GSettings
        let hostsStr = this._settings.get_string('hosts-json');
        try {
            this._hosts = JSON.parse(hostsStr);
        } catch (e) {
            this._hosts = [];
        }

        // Подсигуряване на състоянието за новите обекти
        this._hosts.forEach(h => {
            if (!this._hostsStatus[h.id]) {
                this._hostsStatus[h.id] = { status: 'UNKNOWN' };
            }
            
            let item = new PopupMenu.PopupMenuItem(`${h.name} (${h.address}): UNKNOWN`);
            this._indicator.menu.addMenuItem(item);
            this._menuItems[h.id] = item;
        });

        // Предизвикване на проверка веднага след промяна на списъка
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
        if (!this._hosts || this._hosts.length === 0) return;

        let pingCount = this._settings.get_int('ping-count').toString();

        // Асинхронно изпращане на ping заявки в паралел
        let promises = this._hosts.map(async (host) => {
            let isUp = await this._pingAddress(host.address, pingCount);
            return { id: host.id, isUp };
        });

        let results = await Promise.all(promises);
        let pingResults = {};
        results.forEach(r => pingResults[r.id] = r.isUp);

        // Изчисляване на състоянието по йерархия
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
                    newStatus = 'UNKNOWN'; // Заглушаване ("Тихо" състояние)
                } else {
                    newStatus = physicalUp ? 'UP' : 'DOWN';
                }
            }

            currentRecord.status = newStatus;
            this._hostsStatus[host.id] = currentRecord;

            // Известяване за грешка само при реална промяна от работещо състояние
            if (newStatus === 'DOWN' && oldStatus !== 'DOWN') {
                this._notifyHostDown(host);
            }

            // Обновяване на съответния ред в менюто
            if (this._menuItems[host.id]) {
                let statusEmoji = newStatus === 'UP' ? '🟢 UP' : (newStatus === 'DOWN' ? '🔴 DOWN' : '⚪ UNKNOWN');
                this._menuItems[host.id].label.set_text(`${host.name} (${host.address}): ${statusEmoji}`);
            }
        });
    }

    _pingAddress(address, count) {
        return new Promise((resolve) => {
            try {
/*
                let proc = new Gio.Subprocess({
                    argv: ['ping', '-c', count, '-W', '2', address],
                    flags: Gio.SubprocessFlags.STDOUT_DEV_NULL | Gio.SubprocessFlags.STDERR_DEV_NULL
                    // flags: Gio.SubprocessFlags.NONE
                });
*/
               let commandString = `ping -c ${count} -W 2 ${address} 1>/dev/null 2>&1`;
                
                let proc = new Gio.Subprocess({
                    argv: ['sh', '-c', commandString],
                    flags: Gio.SubprocessFlags.NONE
                });

                proc.init(null);
                proc.wait_async(null, (obj, res) => {
                    try {
                        // resolve(obj.wait_finish(res));
                        obj.wait_finish(res);
                        // Проверяваме реалния изходен код (Exit Code) на командата
                        if (obj.get_if_exited()) {
                            let exitCode = obj.get_exit_status();
                            // Изходен код 0 означава, че хостът е UP (успешен отговор на пакетите)
			    // console.log("Host Up:", address, " ", exitCode);
                            resolve(exitCode === 0);
                        } else {
			    console.log("Host Down:", address, " ", exitCode);
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

    _notifyHostDown(host) {
        Main.notify(
            `Връзката прекъсна: ${host.name}`,
            `Хост ${host.address} не отговаря, но инфраструктурата преди него е активна.`
        );
    }
}
