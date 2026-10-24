'use strict';

module.exports = {
  config: {
    name: 'help',
    aliases: ['h', 'menu'],
    description: 'কমান্ডের তালিকা আর ব্যবহারের নিয়ম দেখো।',
    usage: '{p}help [কমান্ডের নাম]',
    examples: ['{p}help', '{p}help help'],
    category: 'utility',
    role: 0,
    cooldown: 3,
  },

  async onStart({ args, commands, prefix, botName, reply }) {
    const fill = (text) => text.split('{p}').join(prefix);

    // .help <command>  → details for one command
    if (args.length > 0) {
      const q = args[0].toLowerCase();
      const cmd = commands.find((c) => c.name === q || c.aliases.includes(q));
      if (!cmd) {
        await reply(`এই কমান্ডটা খুঁজে পেলাম না। ${prefix}help লিখে কমান্ডগুলো দেখে নাও।`);
        return;
      }
      const lines = [`📖 ${prefix}${cmd.name}`, cmd.description, `ব্যবহার: ${fill(cmd.usage)}`];
      if (cmd.aliases.length) lines.push(`অন্য নাম: ${cmd.aliases.map((a) => prefix + a).join(', ')}`);
      if (cmd.examples.length) lines.push('উদাহরণ:', ...cmd.examples.map((e) => `  ${fill(e)}`));
      await reply(lines.join('\n'));
      return;
    }

    // .help → grouped list (the handler already hides admin-only commands from non-admins)
    const groups = new Map();
    for (const c of commands) {
      if (!groups.has(c.category)) groups.set(c.category, []);
      groups.get(c.category).push(c);
    }
    const lines = [`🤖 ${botName}`, 'অবশ্যই বন্ধু! নিচে আমার কমান্ডগুলো দেওয়া আছে।', `প্রিফিক্স: ${prefix}`, ''];
    for (const [category, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`📂 ${category}`);
      for (const c of list) lines.push(`• ${prefix}${c.name} — ${c.description}`);
      lines.push('');
    }
    lines.push(`কোনো কমান্ডের বিস্তারিত জানতে লিখো: ${prefix}help <কমান্ডের নাম>`, `উদাহরণ: ${prefix}help help`);
    await reply(lines.join('\n'));
  },
};
