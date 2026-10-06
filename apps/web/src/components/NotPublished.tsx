/** Marca visible para un dato que la ficha técnica no publica. Nunca se muestra como 0. */
export function NotPublished({ label = 'No publicado' }: { label?: string }) {
  return (
    <span className="not-published" title="Este dato no aparece en la ficha técnica del fabricante">
      {label}
    </span>
  );
}

export function Value({ text }: { text: string | null }) {
  return text == null ? <NotPublished /> : <>{text}</>;
}
