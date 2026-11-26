import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../global.css';
import { SiteLayout } from '../components/SiteLayout';
import { HomePage } from '../pages/HomePage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SiteLayout activeRoute="home">
      <HomePage />
    </SiteLayout>
  </StrictMode>
);
