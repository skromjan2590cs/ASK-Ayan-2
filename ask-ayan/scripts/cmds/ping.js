'use strict';
module.exports = {
  config: {
    name: 'ping', aliases: ['p'], description: 'বট জেগে আছে কিনা দেখো।',
    usage: '{p}ping', examples: ['{p}ping'], category: 'utility', role: 0, cooldown: 3,
  },
  async onStart({ reply, formatTime }) {
    await reply(`পং! 🏓 এখন সময়: ${formatTime()}`);
  },
};
