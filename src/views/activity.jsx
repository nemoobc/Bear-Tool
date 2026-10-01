// ACTIVITY
export default function ActivityView() {
  return (
        <section className="view" id="view-activity">
          <div className="card">
            <div className="card-title"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> <span data-i18n="nav.activity">Activity</span></div>
            <div className="activity-timeline" id="activityList"><div className="empty-state"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>No transactions yet</p></div></div>
          </div>
        </section>
  );
}
