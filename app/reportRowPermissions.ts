type ReportActor = { id: number; role: string };

/** Status grants are checked separately. Foremen can mutate only their own rows. */
export function canModifyReportOwner(actor: ReportActor, ownerUserId: number | null | undefined) {
  return actor.role !== "foreman" || ownerUserId === actor.id;
}
