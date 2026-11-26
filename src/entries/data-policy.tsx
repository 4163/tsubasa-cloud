import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../global.css';
import { SiteLayout } from '../components/SiteLayout';
import { DataPolicyPage } from '../pages/DataPolicyPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SiteLayout activeRoute="data-policy" fitViewport>
      <DataPolicyPage />
    </SiteLayout>
  </StrictMode>
);
