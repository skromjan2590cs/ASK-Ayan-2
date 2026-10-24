const fs = require("fs-extra");
const path = __dirname + "/cache/autoseen.json";

// যদি ফাইল না থাকে, বানানো হবে
if (!fs.existsSync(path)) {
  fs.writeFileSync(path, JSON.stringify({ status: true }, null, 2));
}

module.exports = {
  config: {
    name: "autoseen",
    version: "1.0",
    author: "ASK-Ayan👑",
    countDown: 0,
    role: 0,
    shortDescription: "স্বয়ংক্রিয়ভাবে seen সিস্টেম",
    longDescription: "বট স্বয়ংক্রিয়ভাবে সকল নতুন মেসেজ seen করবে।",
    category: "system",
    guide: {
      en: "{pn} on/off",
    },
  },

  onStart: async function ({ message, args }) {
    const data = JSON.parse(fs.readFileSync(path));
    if (!args[0]) {
      return message.reply(`📄 Autoseen বর্তমান অবস্থা: ${data.status ? "✅ চালু" : "❌ বন্ধ"}`);
    }

    if (args[0].toLowerCase() === "on") {
      data.status = true;
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
      return message.reply("✅ Autoseen এখন থেকে চালু!");
    } else if (args[0].toLowerCase() === "off") {
      data.status = false;
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
      return message.reply("❌ Autoseen এখন বন্ধ!");
    } else {
      return message.reply("⚠️ ব্যবহার করুন: autoseen on / off");
    }
  },

  // মেসেজ দেখলেই seen করবে (যদি চালু থাকে)
  onChat: async function ({ event, api }) {
    try {
      const data = JSON.parse(fs.readFileSync(path));
      if (data.status === true) {
        api.markAsReadAll();
      }
    } catch (e) {
      console.error(e);
    }
  },
};
