export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="small">{children}</p> : null}
    </div>
  );
}
