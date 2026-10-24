const os = require("os");
const pidusage = require("pidusage");
const { execSync } = require("child_process");

module.exports = {
    config: {
        name: "rtm",
        version: "1.6",
        author: "𝗔𝗿𝗶𝘆𝗮𝗻 𝗯𝗯'𝘇", 
        countDown: 10,
        role: 0,
        shortDescription: {
            en: "Show system & bot stats",
            bn: "সিস্টেম এবং বটের স্ট্যাটাস দেখুন"
        },
        longDescription: {
            en: "Display CPU, RAM, disk usage, uptime, users, groups etc.",
            bn: "CPU, RAM, Disk, Uptime, User, Group ইত্যাদি দেখাবে"
        },
        category: "system"
    },

    onStart: async function ({ message, api, event, threadsData, usersData, commands }) {
        let sent;
        try {
            sent = await message.reply(">🎀 𝐋𝐨𝐚𝐝𝐢𝐧𝐠..\n█▒");
            const bar = ["██▒▒▒▒", "██████▒▒▒▒", "██████████"];
            for (let i = 0; i < bar.length; i++) {
                await new Promise(r => setTimeout(r, 500));
                await api.editMessage(`✨ 𝐋𝐨𝐚𝐝𝐢𝐧𝐠...\n${bar[i]}`, sent.messageID);
            }

            // CPU & Memory usage
            const stats = await pidusage(process.pid);
            const cpuUsage = stats.cpu.toFixed(2);
            const usedMem = stats.memory / 1024 / 1024;
            const totalMem = os.totalmem() / 1024 / 1024;
            const freeMem = os.freemem() / 1024 / 1024;

            // Disk usage
            let diskTotal = 0, diskUsed = 0, diskFree = 0;
            try {
                const df = execSync("df -k --total").toString().split("\n");
                const totalLine = df[df.length - 2].trim().split(/\s+/);
                diskTotal = (parseInt(totalLine[1]) / 1024 / 1024).toFixed(2);
                diskUsed = (parseInt(totalLine[2]) / 1024 / 1024).toFixed(2);
                diskFree = (parseInt(totalLine[3]) / 1024 / 1024).toFixed(2);
            } catch {
                diskTotal = totalMem.toFixed(2);
                diskUsed = usedMem.toFixed(2);
                diskFree = freeMem.toFixed(2);
            }

            // Uptime
            const botUptime = formatTime(process.uptime() * 1000);
            const sysUptime = formatTime(os.uptime() * 1000);

            // System info
            const cpuModel = os.cpus()[0].model;
            const nodeVersion = process.version;
            const osVersion = os.version ? os.version() : os.type() + " " + os.release();
            const platform = os.platform();
            const hostname = os.hostname();

            // Bot info
            const totalUsers = (await usersData.getAll()).length;
            const totalGroups = (await threadsData.getAll()).length;
            const totalCommands = commands?.size || 0;
            const botName = "𝗔𝗿𝗶𝘆𝗮𝗻 𝗯𝗯'𝘇 𝗕𝗼𝘁"; // <-- tor bot er nam
            const ping = ((Date.now() - event.timestamp) / 1000).toFixed(2);

            // Version check
            let botVersion = "unknown";
            try {
                botVersion = require(process.cwd() + "/package.json").version || "unknown";
            } catch { }

            const info = `
>🎀 𝐔𝐒𝐄𝐑𝐒 & 𝐆𝐑𝐎𝐔𝐏𝐒
• Total Users : ${totalUsers}
• Total Groups : ${totalGroups}
• Commands : ${totalCommands}

𝐑𝐀𝐌 𝐈𝐍𝐅𝐎
• Total RAM : ${totalMem.toFixed(2)} MB
• Free RAM : ${freeMem.toFixed(2)} MB
• Used RAM : ${usedMem.toFixed(2)} MB

𝐃𝐈𝐒𝐊 𝐔𝐒𝐀𝐆𝐄
• Total Disk : ${diskTotal} GB
• Used Disk : ${diskUsed} GB
• Free Disk : ${diskFree} GB

𝐁𝐎𝐓 𝐒𝐓𝐀𝐓𝐔𝐒
• Bot Uptime : ${botUptime}
• Server Uptime : ${sysUptime}
• Ping : ${ping}s
• Bot Name : ${botName}
• Bot Version : ${botVersion}
• Hostname : ${hostname}
• Author : 𝗔𝗿𝗶𝘆𝗮𝗻 𝗯𝗯'𝘇

𝐂𝐏𝐔 & 𝐒𝐘𝐒𝐓𝐄𝐌
• CPU Model : ${cpuModel}
• CPU Usage : ${cpuUsage}%
• Platform : ${platform}
• OS Version : ${osVersion}
• Node.js : ${nodeVersion}
`.trim();

            await new Promise(r => setTimeout(r, 600));
            await api.editMessage(info, sent.messageID);

        } catch (err) {
            if (sent?.messageID) {
                api.editMessage("𝐅𝐚𝐢𝐥𝐞𝐝: " + err.message, sent.messageID);
            } else {
                message.reply("𝐅𝐚𝐢𝐥𝐞𝐝: " + err.message);
            }
        }
    }
};

function formatTime(ms) {
    const d = Math.floor(ms / (1000 * 60 * 60 * 24));
    const h = Math.floor(ms / (1000 * 60 * 60)) % 24;
    const m = Math.floor(ms / (1000 * 60)) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return `${d}d ${h}h ${m}m ${s}s`;
  }
