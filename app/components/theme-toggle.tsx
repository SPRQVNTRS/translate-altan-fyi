import { Monitor, Moon, Sun } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { z } from 'zod';
import { cn } from '#app/lib/utils';

const themeSchema = z.enum(['system', 'light', 'dark']).catch('system');
type Theme = z.infer<typeof themeSchema>;

declare global {
  interface Window {
    __applyTheme?: () => void;
    __getStoredTheme?: () => string;
  }
}

function getStoredTheme(): Theme {
  // The inline boot script in root.tsx installs `__getStoredTheme`; it is absent
  // during SSR and before hydration, where `system` is the right default.
  return themeSchema.parse(globalThis.window?.__getStoredTheme?.());
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sync state from localStorage on mount
  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  // Handle click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      // SAFETY: `contains` accepts any Node; a MouseEvent target is always a
      // Node in the DOM, but the DOM lib types `EventTarget` as its supertype.
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Apply theme when it changes
  useEffect(() => {
    localStorage.setItem('theme', theme);
    window.__applyTheme?.();
  }, [theme]);

  // Listen for system preference changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      window.__applyTheme?.();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const themes = [
    { value: 'system' as const, label: 'System', icon: Monitor },
    { value: 'light' as const, label: 'Light', icon: Sun },
    { value: 'dark' as const, label: 'Dark', icon: Moon },
  ];

  const currentTheme = themes.find((t) => t.value === theme) || themes[0];

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative inline-flex items-center justify-center h-8 w-8 p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded-lg transition-colors"
        aria-label="Theme selector"
        aria-expanded={isOpen}
      >
        <currentTheme.icon className="h-4 w-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-36 rounded-md shadow-lg bg-popover border ring-1 ring-black ring-opacity-5">
          <div className="py-1" role="menu">
            {themes.map((themeOption) => {
              const Icon = themeOption.icon;
              const isActive = theme === themeOption.value;

              return (
                <button
                  key={themeOption.value}
                  onClick={() => {
                    setTheme(themeOption.value);
                    setIsOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center px-4 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                  role="menuitem"
                >
                  <Icon className="h-4 w-4 mr-2" />
                  {themeOption.label}
                  {isActive && <span className="ml-auto text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
