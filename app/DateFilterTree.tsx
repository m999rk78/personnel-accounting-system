"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { VirtualChoiceList } from "./VirtualChoiceList";
import { dateFilterPath, dateFilterTreeLabel, matchesDateFilterSearch } from "./dateFilterTreeModel";
import "./DateFilterTree.css";

type DateChoice = { value: string; count: number };
type DateTreeNode = {
  id: string;
  path: string[];
  label: string;
  values: string[];
  count: number;
  children: Map<string, DateTreeNode>;
};

function DateCheckbox({ checked, mixed, label, onChange }: { checked: boolean; mixed: boolean; label: string; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" checked={checked} aria-label={label} onChange={event => onChange(event.target.checked)} />;
}

/** Keep calendar grouping separate from the raw keys stored in the filter model. */
function buildDateTree(values: readonly DateChoice[], search: string) {
  const roots = new Map<string, DateTreeNode>();
  const nodes = new Map<string, DateTreeNode>();
  const matching = values.filter(({ value }) => matchesDateFilterSearch(value, search))
    .map(value => ({ ...value, path: dateFilterPath(value.value) }))
    .sort((left, right) => {
      const leftDate = left.path.length === 3, rightDate = right.path.length === 3;
      if (leftDate && rightDate) return right.path.join("-").localeCompare(left.path.join("-"));
      if (leftDate !== rightDate) return leftDate ? -1 : 1;
      if (!left.value || !right.value) return left.value ? -1 : right.value ? 1 : 0;
      return left.value.localeCompare(right.value, "ru");
    });
  for (const { value, count, path } of matching) {
    let children = roots;
    for (let depth = 0; depth < path.length; depth++) {
      const key = path[depth];
      let node = children.get(key);
      if (!node) {
        const currentPath = path.slice(0, depth + 1);
        node = { id: JSON.stringify(currentPath), path: currentPath, label: dateFilterTreeLabel(key, depth, path.slice(0, depth)), values: [], count: 0, children: new Map() };
        children.set(key, node);
        nodes.set(node.id, node);
      }
      // ISO and displayed dates can share a day, but retain their individual raw keys.
      node.values.push(value);
      node.count += count;
      children = node.children;
    }
  }
  return { roots, nodes };
}

export function DateFilterTree({ values, selected, onChange, search }: {
  values: readonly DateChoice[];
  selected: ReadonlySet<string>;
  onChange: (selection: Set<string>) => void;
  search: string;
}) {
  // New years and months open automatically; only explicit collapses are retained.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const tree = useMemo(() => buildDateTree(values, search), [values, search]);
  const selectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of tree.nodes.values()) counts.set(node.id, node.values.reduce((total, value) => total + Number(selected.has(value)), 0));
    return counts;
  }, [tree, selected]);
  const visible = useMemo(() => {
    const ids: string[] = [];
    const append = (children: Map<string, DateTreeNode>) => {
      for (const node of children.values()) {
        ids.push(node.id);
        if (!collapsed.has(node.id)) append(node.children);
      }
    };
    append(tree.roots);
    return ids;
  }, [tree, collapsed]);
  const toggleExpanded = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <div className="date-filter-tree" role="group" aria-label="Даты: годы, месяцы и дни">
    <VirtualChoiceList key={search} items={visible} emptyText={search ? "Ничего не найдено. Попробуйте другой запрос." : "Нет значений с учётом остальных фильтров."} renderItem={id => {
      const node = tree.nodes.get(id)!;
      const checkedCount = selectionCounts.get(id) ?? 0;
      const checked = checkedCount === node.values.length;
      const mixed = checkedCount > 0 && !checked;
      const branch = node.children.size > 0;
      const expanded = !collapsed.has(id);
      const contextLabel = node.path.map((key, depth) => dateFilterTreeLabel(key, depth, node.path.slice(0, depth))).join(", ");
      return <div className={`date-filter-tree-row${branch ? " date-filter-tree-branch" : ""}`} style={{ paddingLeft: 8 + (node.path.length - 1) * 18 }}>
        {branch ? <button className="date-filter-tree-expand" type="button" aria-label={`${expanded ? "Свернуть" : "Развернуть"}: ${contextLabel}`} aria-expanded={expanded} onClick={() => toggleExpanded(id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} /></svg></button> : <span className="date-filter-tree-spacer" aria-hidden="true" />}
        <label className="date-filter-tree-choice"><DateCheckbox checked={checked} mixed={mixed} label={contextLabel} onChange={isChecked => {
          const next = new Set(selected);
          for (const value of node.values) { if (isChecked) next.add(value); else next.delete(value); }
          onChange(next);
        }} /><span className="date-filter-tree-label" title={node.label}>{node.label}</span><small className="date-filter-tree-count" title="Количество строк">{node.count}</small></label>
      </div>;
    }} />
  </div>;
}
