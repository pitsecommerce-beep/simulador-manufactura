import { render, screen, within } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogVariantDetail } from '@sim/domain';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { Api } from '../src/lib/api';
import { AppProvider } from '../src/lib/context';
import { CatalogVariantPage } from '../src/pages/CatalogVariantPage';

const sb = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe() {} } } }),
  },
} as unknown as SupabaseClient;

const src = [{ file: 'datasheet.pdf', page: 2, section: 'Specifications' }];
const detail: CatalogVariantDetail = {
  variant: {
    slug: 'irb-360-1-1130',
    variant_code: 'IRB 360-1/1130',
    robot_slug: 'irb-360',
    model: 'IRB 360',
    manufacturer: 'ABB',
    family: 'Delta',
    kinematic_type: 'delta',
    application: 'Pick-and-place',
    axes_count: null,
    axes_note: '3 o 4',
    reach_mm: null,
    workspace_diameter_mm: 1130,
    payload_kg: 1,
  },
  robot: {
    slug: 'irb-360',
    model: 'IRB 360',
    manufacturer: 'ABB',
    family: 'Delta',
    application: null,
    typical_application: null,
    product_page: null,
    data_status: 'ok',
    notes: null,
  },
  specs: {
    axes_count: null,
    axes_note: '3 o 4',
    reach_mm: null,
    workspace_diameter_mm: 1130,
    payload_kg: 1,
    payload_note: null,
    armload_kg: null,
    weight_kg: 120,
    repeatability_mm: null,
    repeatability: null,
    mounting_allowed: ['inverted'],
    ip_rating: null,
    controller: null,
    axis_limits: null,
    published_cycle_times: null,
    max_tcp_speed_m_s: null,
    extra: null,
    notes: null,
    provenance: { reach_mm: src, payload_kg: src, weight_kg: src, workspace_diameter_mm: src },
  },
  documents: [
    {
      path: 'datasheet.pdf',
      kind: 'datasheet',
      doc_id: 'ROB0082EN_G',
      revision: 'K',
      doc_date: null,
      title: 'IRB 360 Data sheet',
      url: 'https://search.abb.com/x',
      library_page: null,
      accessed_at: '2026-09-30T00:00:00Z',
      license_terms: 'Documento público de ABB Library',
    },
  ],
  siblings: [],
};

it('marca los datos no publicados y muestra la fuente de los publicados', async () => {
  const api = { getCatalogVariant: vi.fn().mockResolvedValue(detail) } as unknown as Api;
  render(
    <AppProvider supabase={sb} api={api}>
      <MemoryRouter initialEntries={['/catalogo/irb-360-1-1130']}>
        <Routes>
          <Route path="/catalogo/:slug" element={<CatalogVariantPage />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>,
  );
  const reach = (await screen.findByText('Alcance')).parentElement!;
  expect(within(reach).getByText('No publicado')).toBeInTheDocument();
  // Un dato no publicado no muestra fuente ni se convierte en 0.
  expect(within(reach).queryByText(/datasheet\.pdf/)).toBeNull();
  expect(within(reach).queryByText(/^0/)).toBeNull();

  const payload = screen.getByText('Carga útil').parentElement!;
  expect(within(payload).getByText('1 kg')).toBeInTheDocument();
  expect(within(payload).getByText('datasheet.pdf p. 2')).toBeInTheDocument();
  expect(within(payload).getByText(/Documento público de ABB Library/)).toBeInTheDocument();

  expect(screen.getByText('Rangos y velocidades de ejes no publicados')).toBeInTheDocument();
  expect(screen.getByText('3 o 4')).toBeInTheDocument();
});
