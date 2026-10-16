// Miniatura paramétrica de la familia del robot, generada por código. No es un render del
// CAD: los renders llegan con el pipeline de CAD (fase 2b).

export const ICON_NOTICE = 'Ícono paramétrico de la familia (aún no hay renders del CAD).';

export function RobotIcon({
  kinematicType,
  className = 'h-10 w-10',
}: {
  kinematicType: string | null;
  className?: string;
}) {
  const stroke = {
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  let body;
  switch (kinematicType) {
    case 'delta':
      body = (
        <>
          <path d="M8 8h24" {...stroke} />
          <path d="M11 8l5 9 3 12M29 8l-5 9-3 12M20 8v10l0 11" {...stroke} />
          <path d="M16 29h8" {...stroke} />
        </>
      );
      break;
    case 'scara':
      body = (
        <>
          <path d="M8 34h10M13 34V12" {...stroke} />
          <path d="M13 12h12l8 6" {...stroke} />
          <path d="M33 18v12" {...stroke} />
        </>
      );
      break;
    case 'parallel_linkage':
      body = (
        <>
          <path d="M7 34h14M14 34v-6" {...stroke} />
          <path d="M14 28l-3-14 20-4M17 28l-3-14M31 10v14" {...stroke} />
          <path d="M27 24h8" {...stroke} />
        </>
      );
      break;
    default:
      body = (
        <>
          <path d="M7 34h14M14 34v-6" {...stroke} />
          <path d="M14 28l4-14 13 4 2 8" {...stroke} />
          <circle cx="18" cy="14" r="1.8" fill="currentColor" />
          <circle cx="31" cy="18" r="1.8" fill="currentColor" />
        </>
      );
  }
  return (
    <span
      className={`${className} inline-flex shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600`}
      title={ICON_NOTICE}
    >
      <svg viewBox="0 0 40 40" className="h-full w-full p-1" role="img" aria-label="Robot">
        {body}
      </svg>
    </span>
  );
}
