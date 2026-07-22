import { useEffect, useRef, useState } from 'react';

import { playMenuTick } from '../audio/sounds';
import { PixelIcon } from './PixelIcon';

export interface MenuEntry {
  id: string;
  label?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface MenuDefinition {
  id: string;
  label?: string;
  system?: boolean;
  entries: MenuEntry[];
}

interface MenuBarProps {
  menus: MenuDefinition[];
  clock: string;
}

export function MenuBar({ menus, clock }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (!bar.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  const activate = (menu: MenuDefinition): void => {
    playMenuTick();
    setOpenMenu((current) => (current === menu.id ? null : menu.id));
  };

  const invoke = (entry: MenuEntry): void => {
    if (entry.disabled || entry.separator) return;
    setOpenMenu(null);
    playMenuTick();
    entry.action?.();
  };

  return (
    <header className="menu-bar" ref={bar}>
      <nav aria-label="Finder menus" className="menu-strip">
        {menus.map((menu) => {
          const open = openMenu === menu.id;
          return (
            <div className={`menu-root ${open ? 'is-open' : ''}`} key={menu.id}>
              <button
                aria-expanded={open}
                aria-haspopup="menu"
                aria-label={menu.system ? 'System' : menu.label}
                className={`menu-title ${menu.system ? 'system-menu-title' : ''}`}
                data-menu={menu.id}
                onClick={() => activate(menu)}
                onPointerEnter={() => {
                  if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
                }}
                type="button"
              >
                {menu.system ? <PixelIcon name="computer" size={18} /> : menu.label}
              </button>
              {open && (
                <div
                  aria-label={`${menu.label ?? 'System'} menu`}
                  className="menu-popover"
                  role="menu"
                >
                  {menu.entries.map((entry) =>
                    entry.separator ? (
                      <div className="menu-separator" key={entry.id} role="separator" />
                    ) : (
                      <button
                        aria-checked={entry.checked}
                        className="menu-item"
                        data-menu-action={entry.id}
                        disabled={entry.disabled}
                        key={entry.id}
                        onClick={() => invoke(entry)}
                        role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                        type="button"
                      >
                        <span className="menu-check">{entry.checked ? '✓' : ''}</span>
                        <span className="menu-label">{entry.label}</span>
                        <span className="menu-shortcut">{entry.shortcut}</span>
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <time className="menu-clock">{clock}</time>
    </header>
  );
}
