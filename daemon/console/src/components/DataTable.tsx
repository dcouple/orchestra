import type { ReactNode } from "react";

export interface Column<T> { key: string; heading: string; render: (row: T) => ReactNode }
export function DataTable<T>({ caption, columns, rows, rowKey, empty }: {
  caption: string; columns: Array<Column<T>>; rows: T[]; rowKey: (row: T) => string; empty: string;
}) {
  if (!rows.length) return <div className="empty" role="status">{empty}</div>;
  return <div className="table-wrap"><table><caption className="sr-only">{caption}</caption><thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.heading}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key} data-label={column.heading}>{column.render(row)}</td>)}</tr>)}</tbody></table></div>;
}
