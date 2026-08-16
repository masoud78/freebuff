import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { DestinationDetailPage } from '../pages/DestinationDetailPage';
import { DestinationsPage } from '../pages/DestinationsPage';
import { NewProcessingPage } from '../pages/NewProcessingPage';
import { NewSessionUploadPage } from '../pages/NewSessionUploadPage';
import { SessionPage } from '../pages/SessionPage';
import { SettingsPage } from '../pages/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<NewProcessingPage />} />
        <Route path="sessions/new" element={<NewSessionUploadPage />} />
        <Route path="sessions/:id" element={<SessionPage />} />
        <Route path="destinations" element={<DestinationsPage />} />
        <Route path="destinations/:id" element={<DestinationDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
