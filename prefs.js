import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HierarchyPingMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._window = window; // Пазим референция за диалоговите прозорци
        
        // Страница "Настройки"
        const page = new Adw.PreferencesPage({
            title: 'Настройки',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(page);

        // 1. Група за времеви параметри
        const generalGroup = new Adw.PreferencesGroup({ title: 'Параметри за проверка' });
        page.add(generalGroup);

        // Поле за интервал
        const intervalRow = new Adw.SpinRow({
            title: 'Интервал (секунди)',
            adjustment: new Gtk.Adjustment({ lower: 5, upper: 3600, step_increment: 1, value: settings.get_int('interval-seconds') })
        });
        intervalRow.connect('notify::value', () => {
            settings.set_int('interval-seconds', intervalRow.get_value());
        });
        generalGroup.add(intervalRow);

        // Поле за брой пакети
        const countRow = new Adw.SpinRow({
            title: 'Брой пакети (ping count)',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 10, step_increment: 1, value: settings.get_int('ping-count') })
        });
        countRow.connect('notify::value', () => {
            settings.set_int('ping-count', countRow.get_value());
        });
        generalGroup.add(countRow);

        // 2. Нова група: Архивиране и експорт на конфигурацията
        const backupGroup = new Adw.PreferencesGroup({ title: 'Управление на конфигурационни файлове' });
        page.add(backupGroup);

        let backupActionRow = new Adw.ActionRow({
            title: 'Експорт и Импорт на списъка с хостове',
            subtitle: 'Запишете текущите хостове във външен JSON файл или възстановете от съществуващ.'
        });
        backupGroup.add(backupActionRow);

        // Бутон за Експорт
        let exportBtn = new Gtk.Button({ 
            label: 'Експорт във файл', 
            icon_name: 'document-save-symbolic',
            valign: Gtk.Align.CENTER,
            margin_end: 6
        });
        exportBtn.connect('clicked', () => this._exportToFile(settings));
        backupActionRow.add_suffix(exportBtn);

        // Бутон за Импорт
        let importBtn = new Gtk.Button({ 
            label: 'Импорт от файл', 
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']
        });
        importBtn.connect('clicked', () => this._importFromFile(settings, () => refreshHostListUi()));
        backupActionRow.add_suffix(importBtn);

        // 3. Група за управление на хостове
        const hostsGroup = new Adw.PreferencesGroup({ title: 'Списък с хостове за мониторинг' });
        page.add(hostsGroup);

        // Контейнер за динамичния списък с хостове
        const listContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        hostsGroup.add(listContainer);

        const saveHosts = (hostsArray) => {
            settings.set_string('hosts-json', JSON.stringify(hostsArray));
        };

        // Основна функция за визуализиране на списъка
        const refreshHostListUi = () => {
            let child = listContainer.get_first_child();
            while (child) {
                listContainer.remove(child);
                child = listContainer.get_first_child();
            }

            let currentHosts = [];
            try {
                currentHosts = JSON.parse(settings.get_string('hosts-json'));
            } catch (e) {
                currentHosts = [];
            }

            currentHosts.forEach((host, index) => {
                let rowBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
                rowBox.set_margin_bottom(8);

                let nameLabel = new Gtk.Label({ label: `<b>${host.name}</b> (${host.address}) [ID: ${host.id} Родител ID: ${host.parent || 'Няма'}]`, use_markup: true, xalign: 0 });
                rowBox.append(nameLabel);

                let spacer = new Gtk.Label({ hexpand: true });
                rowBox.append(spacer);

                let deleteBtn = new Gtk.Button({ icon_name: 'user-trash-symbolic', css_classes: ['destructive-action'] });
                deleteBtn.connect('clicked', () => {
                    currentHosts.splice(index, 1);
                    saveHosts(currentHosts);
                    refreshHostListUi();
                });
                rowBox.append(deleteBtn);

                listContainer.append(rowBox);
            });

            // Блок за добавяне на нов хост
            let addGroupLabel = new Gtk.Label({ label: '<b>Добавяне на нов хост:</b>', use_markup: true, margin_top: 15, xalign: 0 });
            listContainer.append(addGroupLabel);

            let entryBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
            let entryId = new Gtk.Entry({ placeholder_text: 'ID (напр. nas)' });
            let entryName = new Gtk.Entry({ placeholder_text: 'Име (напр. Локален NAS)' });
            let entryIp = new Gtk.Entry({ placeholder_text: 'IP / Хост (напр. 192.168.1.5)' });
            let entryParent = new Gtk.Entry({ placeholder_text: 'Родител ID (опция)' });
            
            entryBox.append(entryId);
            entryBox.append(entryName);
            entryBox.append(entryIp);
            entryBox.append(entryParent);

            let addBtn = new Gtk.Button({ icon_name: 'list-add-symbolic', css_classes: ['suggested-action'] });
            addBtn.connect('clicked', () => {
                let id = entryId.get_text().trim();
                let name = entryName.get_text().trim();
                let address = entryIp.get_text().trim();
                let parent = entryParent.get_text().trim() || null;

                if (id && name && address) {
                    currentHosts.push({ id, name, address, parent });
                    saveHosts(currentHosts);
                    refreshHostListUi();
                }
            });
            entryBox.append(addBtn);
            listContainer.append(entryBox);
        };

        refreshHostListUi();
    }

    // Асинхронен Експорт във файл през GTK4 FileDialog
    _exportToFile(settings) {
        let fileDialog = new Gtk.FileDialog({
            title: 'Запази списъка с хостове като...',
            initial_name: 'hosts-monitor-backup.json'
        });

        fileDialog.save(this._window, null, (dialog, result) => {
            try {
                let file = dialog.save_finish(result);
                let jsonContent = settings.get_string('hosts-json');

                // Преобразуваме текстовия низ в байтове (Uint8Array), което се изисква от GIO
                let encoder = new TextEncoder();
                let bytesData = encoder.encode(jsonContent);
                
                // Записване на низа във файла
                file.replace_contents_async(
                    bytesData,
                    null,
                    false,
                    Gio.FileCreateFlags.NONE,
                    null,
                    (f, res) => {
                        try {
                            f.replace_contents_finish(res);
                        } catch (e) {
                            console.error('Грешка при запис на файл:', e);
                        }
                    }
                );
            } catch (e) {
                // Потребителят е затворил прозореца без да избере файл
            }
        });
    }

    // Асинхронен Импорт от външен файл с валидация
    _importFromFile(settings, onCompleteCallback) {
        let fileDialog = new Gtk.FileDialog({
            title: 'Избери JSON файл за импортиране'
        });

        fileDialog.open(this._window, null, (dialog, result) => {
            try {
                let file = dialog.open_finish(result);
                
                file.load_contents_async(null, (f, res) => {
                    try {
                        let [success, contents] = f.load_contents_finish(res);
                        if (success) {
                            let jsonString = new TextDecoder().decode(contents);
                            
                            // Задължителна валидация на JSON структурата
                            JSON.parse(jsonString); 
                            
                            // Записване в GSettings
                            settings.set_string('hosts-json', jsonString);
                            
                            // Обновяване на UI интерфейса веднага
                            if (onCompleteCallback) onCompleteCallback();
                        }
                    } catch (err) {
                        // Показване на предупреждение при повреден JSON
                        let alert = new Adw.AlertDialog({
                            title: 'Грешка при импорт',
                            body: 'Избраният файл не съдържа валидна JSON структура на хостовете.'
                        });
                        alert.add_response('ok', 'Добре');
                        alert.present(this._window);
                    }
                });
            } catch (e) {
                // Потребителят е затворил прозореца
            }
        });
    }
}
