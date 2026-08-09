import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import ListPage from './pages/ListPage';
import DetailPage from './pages/DetailPage';
import NewPromptPage from './pages/NewPromptPage';
import SettingsPage from './pages/SettingsPage';
import WorkshopPage from './pages/WorkshopPage';
import { HammerIcon, MoonIcon, SunIcon } from './components/icons';
import styles from './App.module.css';

type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  const stored = localStorage.getItem('pf-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pf-theme', theme);
  }, [theme]);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <NavLink to="/" className={styles.brand}>
          <HammerIcon size={18} />
          <span>Prompt Forge</span>
        </NavLink>
        <nav className={styles.nav}>
          <NavLink to="/workshop" className={styles.navLink}>
            工作台
          </NavLink>
          <NavLink to="/settings" className={styles.navLink}>
            设置
          </NavLink>
          <NavLink to="/new" className={styles.newLink}>
            + 新建提示词
          </NavLink>
          <button
            className={styles.themeBtn}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            aria-label="切换主题"
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </nav>
      </header>
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<ListPage />} />
          <Route path="/new" element={<NewPromptPage />} />
          <Route path="/prompts/:id" element={<DetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/workshop" element={<WorkshopPage />} />
        </Routes>
      </main>
    </div>
  );
}
