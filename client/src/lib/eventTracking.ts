// Fire-and-forget analytics for the organiser dashboards. Nothing here may ever throw or
// block the UI. (The server endpoints existed but nothing called them, so views/clicks were always 0.)

const post = (url: string, body?: unknown) => {
  try {
    void fetch(url, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
  } catch {
    /* analytics must never break the page */
  }
};

// One view per event per browser session — re-opening the modal or a re-render isn't a new view.
export function trackEventView(eventId: string): void {
  try {
    const key = `vp_viewed_${eventId}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    /* storage blocked: fall through and count it */
  }
  post(`/api/events/${eventId}/track-view`);
}

// A deliberate interaction with the event (tickets, RSVP, directions, calendar, share...).
export function trackEventClick(eventId: string): void {
  post(`/api/events/${eventId}/track-click`, { actionType: "click" });
}
