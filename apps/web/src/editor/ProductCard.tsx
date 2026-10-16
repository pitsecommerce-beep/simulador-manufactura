import { DEFAULT_PRODUCT_SIZE, type Product, type ProductSize } from '@sim/domain';
import { useState } from 'react';
import { NumberField } from './fields';

/** Producto que sale de la línea y su lista de materiales (BOM) simple. */
export function ProductCard({
  product,
  canEdit,
  onChange,
}: {
  product: Product;
  canEdit: boolean;
  onChange: (p: Product) => void;
}) {
  const [item, setItem] = useState('');
  const add = () => {
    const name = item.trim();
    if (!name || product.bom.some((b) => b.item === name) || name === product.name) return;
    onChange({ ...product, bom: [...product.bom, { item: name, qty: 1 }] });
    setItem('');
  };
  return (
    <fieldset disabled={!canEdit} className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold">Producto y lista de materiales</h3>
      <label className="block text-xs font-medium text-slate-600">
        Producto terminado
        <input
          className="input mt-1 px-2.5 py-1.5"
          value={product.name}
          maxLength={60}
          onChange={(e) => e.target.value.trim() && onChange({ ...product, name: e.target.value })}
        />
      </label>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">
          Medidas (para dibujar y paletizar)
        </p>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ['length_mm', 'Largo'],
              ['width_mm', 'Ancho'],
              ['height_mm', 'Alto'],
            ] as const
          ).map(([k, label]) => (
            <NumberField
              key={k}
              label={label}
              unit="mm"
              value={product.size_mm?.[k] ?? null}
              min={1}
              max={10000}
              required={false}
              placeholder={String(DEFAULT_PRODUCT_SIZE[k])}
              onChange={(v) => {
                const next: ProductSize = {
                  ...(product.size_mm ?? DEFAULT_PRODUCT_SIZE),
                  [k]: v ?? 0,
                };
                onChange({
                  ...product,
                  size_mm: v == null ? null : next,
                });
              }}
            />
          ))}
        </div>
        {!product.size_mm && (
          <p className="mt-1 text-xs text-slate-500">
            Sin medidas se dibuja de {DEFAULT_PRODUCT_SIZE.length_mm} ×{' '}
            {DEFAULT_PRODUCT_SIZE.width_mm} × {DEFAULT_PRODUCT_SIZE.height_mm} mm (supuesto visual).
          </p>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Componentes por unidad</p>
        {product.bom.length === 0 ? (
          <p className="text-xs text-slate-500">
            Sin BOM: el producto entra por las fuentes y solo se procesa. Agrega componentes si una
            estación ensambla.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {product.bom.map((b, i) => (
              <li key={b.item} className="flex items-end gap-2">
                <span className="flex-1 truncate pb-2 text-sm">{b.item}</span>
                <div className="w-24">
                  <NumberField
                    label="Cantidad"
                    value={b.qty}
                    min={1}
                    max={10000}
                    onChange={(v) =>
                      onChange({
                        ...product,
                        bom: product.bom.map((x, j) => (j === i ? { ...x, qty: v ?? 1 } : x)),
                      })
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-danger mb-0.5 px-2 py-1 text-xs"
                  onClick={() =>
                    onChange({ ...product, bom: product.bom.filter((_, j) => j !== i) })
                  }
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <input
            aria-label="Nuevo componente"
            className="input px-2.5 py-1.5"
            placeholder="Ej. caja, tapa, etiqueta"
            value={item}
            maxLength={60}
            onChange={(e) => setItem(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          />
          <button type="button" className="btn btn-secondary py-1.5" onClick={add}>
            Agregar
          </button>
        </div>
      </div>
    </fieldset>
  );
}
