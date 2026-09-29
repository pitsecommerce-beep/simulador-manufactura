import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { createApi } from './lib/api';
import { resolveConfig } from './lib/config';
import { AppProvider } from './lib/context';
import { createSupabase } from './lib/supabase';

const root = createRoot(document.getElementById('root')!);

try {
  const config = resolveConfig(window.__APP_CONFIG__, import.meta.env);
  const supabase = createSupabase(config);
  const api = createApi(config.apiUrl, async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  });
  root.render(
    <StrictMode>
      <AppProvider supabase={supabase} api={api}>
        <App />
      </AppProvider>
    </StrictMode>,
  );
} catch (err) {
  root.render(<p style={{ padding: 24, color: '#b91c1c' }}>{(err as Error).message}</p>);
}
