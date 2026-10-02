// KL-05: how a knowledge source's scope reads to an operator. One place so
// /knowledge, /knowledge/[id] and /documents/[id] say the same thing.

import type { KnowledgeSourceScope } from '@/lib/services/knowledge-scope';

export function scopeLabel(
  scope: KnowledgeSourceScope,
  productNames: ReadonlyMap<string, string>,
): string {
  if (scope.kind === 'workspace') return 'Every product';
  if (scope.needsScope) return 'Needs a scope';
  const names = scope.productProfileIds.map(
    (id) => productNames.get(id.toString()) ?? `product ${id}`,
  );
  return names.join(', ');
}

export function ScopeChip({
  scope,
  productNames,
}: {
  scope: KnowledgeSourceScope;
  productNames: ReadonlyMap<string, string>;
}) {
  const className = scope.needsScope
    ? 'badge badge-bad'
    : scope.kind === 'workspace'
      ? 'badge badge-info'
      : 'badge';
  return (
    <span className={className} data-scope={scope.needsScope ? 'needs_scope' : scope.kind}>
      {scopeLabel(scope, productNames)}
    </span>
  );
}
