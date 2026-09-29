import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Api } from './api';

interface AppContextValue {
  supabase: SupabaseClient;
  api: Api;
  session: Session | null;
  loading: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  supabase,
  api,
  children,
}: {
  supabase: SupabaseClient;
  api: Api;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  return (
    <AppContext.Provider value={{ supabase, api, session, loading }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp fuera de AppProvider');
  return ctx;
}
