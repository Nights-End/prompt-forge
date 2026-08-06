import { Routes, Route, NavLink } from 'react-router-dom';
import ListPage from './pages/ListPage';
import DetailPage from './pages/DetailPage';
import NewPromptPage from './pages/NewPromptPage';
import SettingsPage from './pages/SettingsPage';
import styles from './App.module.css';

export default function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <NavLink to="/" className={styles.brand}>
          ⚒ Prompt Forge
        </NavLink>
        <nav className={styles.nav}>
          <NavLink to="/settings" className={styles.navLink}>
            Settings
          </NavLink>
          <NavLink to="/new" className={styles.newLink}>
            + New Prompt
          </NavLink>
        </nav>
      </header>
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<ListPage />} />
          <Route path="/new" element={<NewPromptPage />} />
          <Route path="/prompts/:id" element={<DetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
