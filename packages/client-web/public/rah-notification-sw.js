self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || "/", self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const existingWindow = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (existingWindow) {
      await existingWindow.focus();
      if ("navigate" in existingWindow && existingWindow.url !== targetUrl) {
        await existingWindow.navigate(targetUrl);
      }
      return;
    }

    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
