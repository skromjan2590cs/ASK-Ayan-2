module.exports = {
  config: {
    name: "autoseen",
    version: "1.0.0",
    author: "skromjan2590cs",
    description: "Automatically marks incoming messages as read"
  },

  onStart: async function ({ api, event }) {
    if (event.type === "message" || event.type === "message_reply") {
      api.markAsRead(event.threadID, (err) => {
        if (err) console.error("Auto seen failed:", err);
      });
    }
  }
};
