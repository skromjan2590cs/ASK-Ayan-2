const { getTime, drive } = global.utils;
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");

module.exports = {
  config: {
    name: "leave",
    version: "3.0",
    author: "Hridoy",
    category: "events"
  },

  langs: {
    vi: {
      session1: "sáng",
      session2: "trưa",
      session3: "chiều",
      session4: "tối",
      leaveType1: "tự rời",
      leaveType2: "bị kick",
      defaultLeaveMessage: "💔 {userName} đã {type} khỏi nhóm.\n🕐 Lúc {session} | 👥 Còn {memberCount} thành viên"
    },
    en: {
      session1: "morning",
      session2: "noon",
      session3: "afternoon",
      session4: "evening",
      leaveType1: "left",
      leaveType2: "was kicked from",
      defaultLeaveMessage: "💔 {userName} {type} the group.\n🕐 {session} | 👥 {memberCount} members remaining"
    }
  },

  onStart: async ({ threadsData, message, event, api, usersData, getLang }) => {
    if (event.logMessageType !== "log:unsubscribe") return;

    const { threadID } = event;
    const threadData = await threadsData.get(threadID);
    if (!threadData.settings.sendLeaveMessage) return;

    const { leftParticipantFbId } = event.logMessageData;
    if (leftParticipantFbId == api.getCurrentUserID()) return;

    const hours   = Number(getTime("HH"));
    const minutes = getTime("mm");
    const threadName = threadData.threadName || "the group";
    const userName   = (await usersData.getName(leftParticipantFbId)) || "Unknown";
    const isKicked   = leftParticipantFbId !== event.author;

    const threadInfo  = await api.getThreadInfo(threadID).catch(() => null);
    const memberCount = threadInfo ? threadInfo.participantIDs.length : "?";

    const session =
      hours < 11 ? getLang("session1") :
      hours < 13 ? getLang("session2") :
      hours < 18 ? getLang("session3") : getLang("session4");

    let { leaveMessage = getLang("defaultLeaveMessage") } = threadData.data;
    leaveMessage = leaveMessage
      .replace(/\{userName\}/g,    userName)
      .replace(/\{type\}/g,        isKicked ? getLang("leaveType2") : getLang("leaveType1"))
      .replace(/\{time\}/g,        `${hours}:${minutes}`)
      .replace(/\{session\}/g,     session)
      .replace(/\{threadName\}/g,  threadName)
      .replace(/\{memberCount\}/g, memberCount);

    const cacheDir  = path.join(__dirname, "cache");
    let   cachePath = null;

    try {
      await fs.ensureDir(cacheDir);

      // ── Font registration ─────────────────────────────────────────────────
      const fontCandidates = [
        { p: "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",        f: "Noto"   },
        { p: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",     f: "DejaVu" },
        { p: "C:\\Windows\\Fonts\\seguisb.ttf",                          f: "Segoe"  },
        { p: "C:\\Windows\\Fonts\\arialuni.ttf",                         f: "ArialUni" }
      ];
      for (const { p, f } of fontCandidates) {
        try { if (fs.existsSync(p)) { registerFont(p, { family: f }); break; } }
        catch (_) {}
      }
      const FONT = "Noto, DejaVu, Segoe, ArialUni, sans-serif";

      // ── Canvas setup ──────────────────────────────────────────────────────
      const W = 1100, H = 560;
      const canvas = createCanvas(W, H);
      const ctx    = canvas.getContext("2d");

      // ── Background ────────────────────────────────────────────────────────
      const bgPool = [
        "https://i.imgur.com/IvVWx0p.jpeg",
        "https://i.imgur.com/4xj735H.jpeg",
        "https://i.imgur.com/eRDopnk.jpeg",
        "https://i.imgur.com/R0ft7rO.jpeg",
        "https://i.imgur.com/wj6Hmbw.jpeg",
        "https://i.imgur.com/K1zUPfa.jpeg",
        "https://i.imgur.com/zNDuJcX.jpeg"
      ];
      const bgUrl = bgPool[Math.floor(Math.random() * bgPool.length)];
      try {
        const bgBuf = await axios.get(bgUrl, { responseType: "arraybuffer", timeout: 8000 });
        const bgImg = await loadImage(Buffer.from(bgBuf.data));
        // Ken-Burns-style: zoom-crop to fill
        const scale = Math.max(W / bgImg.width, H / bgImg.height) * 1.08;
        const bw = bgImg.width  * scale;
        const bh = bgImg.height * scale;
        ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
      } catch (_) {
        const fallback = ctx.createLinearGradient(0, 0, W, H);
        fallback.addColorStop(0,   "#0d0d1f");
        fallback.addColorStop(0.5, "#1a1030");
        fallback.addColorStop(1,   "#0a0a1a");
        ctx.fillStyle = fallback;
        ctx.fillRect(0, 0, W, H);
      }

      // Dark cinematic vignette + tint
      const vignette = ctx.createRadialGradient(W/2, H/2, H*0.1, W/2, H/2, H*0.9);
      vignette.addColorStop(0, "rgba(10,8,30,0.55)");
      vignette.addColorStop(1, "rgba(0,0,10,0.88)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);

      // Subtle scanline texture
      ctx.globalAlpha = 0.03;
      for (let y = 0; y < H; y += 3) {
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.fillRect(0, y, W, 1);
      }
      ctx.globalAlpha = 1;

      // ── Helpers ───────────────────────────────────────────────────────────
      const roundRect = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      };
      const hexPath = (cx, cy, r) => {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          i === 0
            ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
        ctx.closePath();
      };

      // ── Left decorative strip ─────────────────────────────────────────────
      const stripGrad = ctx.createLinearGradient(0, 0, 0, H);
      stripGrad.addColorStop(0,   isKicked ? "rgba(255,70,70,0.9)"  : "rgba(80,120,255,0.9)");
      stripGrad.addColorStop(0.5, isKicked ? "rgba(200,40,100,0.8)" : "rgba(60,200,220,0.8)");
      stripGrad.addColorStop(1,   isKicked ? "rgba(120,0,60,0.7)"   : "rgba(80,60,200,0.7)");
      ctx.fillStyle = stripGrad;
      ctx.fillRect(0, 0, 7, H);

      // ── Main glass card ───────────────────────────────────────────────────
      const PAD = 55, CARD_H = 430;
      const cX = PAD, cY = (H - CARD_H) / 2, cW = W - PAD * 2;

      ctx.shadowColor  = "rgba(0,0,0,0.7)";
      ctx.shadowBlur   = 48;
      ctx.shadowOffsetY = 12;
      roundRect(cX, cY, cW, CARD_H, 26);
      ctx.fillStyle = "rgba(255,255,255,0.065)";
      ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

      // card border with accent
      roundRect(cX, cY, cW, CARD_H, 26);
      const borderGrad = ctx.createLinearGradient(cX, cY, cX + cW, cY + CARD_H);
      borderGrad.addColorStop(0,   isKicked ? "rgba(255,100,100,0.55)" : "rgba(100,140,255,0.55)");
      borderGrad.addColorStop(0.5, "rgba(255,255,255,0.12)");
      borderGrad.addColorStop(1,   isKicked ? "rgba(180,40,80,0.4)"  : "rgba(60,200,255,0.4)");
      ctx.strokeStyle = borderGrad;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // top inner shimmer
      roundRect(cX + 12, cY + 12, cW - 24, 36, 14);
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fill();

      // ── Avatar (hexagon) ──────────────────────────────────────────────────
      const AV_R = 108;
      const AV_CX = cX + 55 + AV_R;
      const AV_CY = cY + CARD_H / 2;

      // animated-look ring (double hex)
      const ringColor = isKicked ? ["rgba(255,80,80,0.9)", "rgba(180,40,100,0.7)"]
                                  : ["rgba(100,160,255,0.9)", "rgba(60,220,255,0.7)"];
      ctx.shadowColor = ringColor[0]; ctx.shadowBlur = 22;
      ctx.strokeStyle = ringColor[0]; ctx.lineWidth = 5;
      hexPath(AV_CX, AV_CY, AV_R + 10); ctx.stroke();

      ctx.shadowColor = ringColor[1]; ctx.shadowBlur = 10;
      ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1.5;
      hexPath(AV_CX, AV_CY, AV_R + 20); ctx.stroke();
      ctx.shadowBlur = 0;

      // avatar image
      try {
        const avBuf = await axios.get(
          `https://arshi-facebook-pp.vercel.app/api/pp?uid=${leftParticipantFbId}`,
          { responseType: "arraybuffer", timeout: 7000 }
        );
        const avImg = await loadImage(Buffer.from(avBuf.data));
        ctx.save();
        hexPath(AV_CX, AV_CY, AV_R); ctx.clip();
        ctx.drawImage(avImg, AV_CX - AV_R, AV_CY - AV_R, AV_R * 2, AV_R * 2);
        ctx.restore();
      } catch (_) {
        ctx.save();
        hexPath(AV_CX, AV_CY, AV_R); ctx.clip();
        const avFallback = ctx.createRadialGradient(AV_CX, AV_CY, 10, AV_CX, AV_CY, AV_R);
        avFallback.addColorStop(0, "#2a2040"); avFallback.addColorStop(1, "#0e0e22");
        ctx.fillStyle = avFallback; ctx.fill();
        ctx.restore();
        ctx.font = `${AV_R * 0.9}px ${FONT}`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("👤", AV_CX, AV_CY);
      }

      // ── Vertical divider ──────────────────────────────────────────────────
      const divX = cX + 55 + AV_R * 2 + 55;
      const divGrad = ctx.createLinearGradient(0, cY + 30, 0, cY + CARD_H - 30);
      divGrad.addColorStop(0,   "rgba(255,255,255,0)");
      divGrad.addColorStop(0.3, isKicked ? "rgba(255,100,100,0.4)" : "rgba(100,180,255,0.4)");
      divGrad.addColorStop(0.7, isKicked ? "rgba(255,100,100,0.4)" : "rgba(100,180,255,0.4)");
      divGrad.addColorStop(1,   "rgba(255,255,255,0)");
      ctx.strokeStyle = divGrad; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(divX, cY + 30); ctx.lineTo(divX, cY + CARD_H - 30); ctx.stroke();

      // ── Right text block ──────────────────────────────────────────────────
      const rX = divX + 44;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign    = "left";

      // "GOODBYE" / "KICKED OUT" headline
      const headText  = isKicked ? "KICKED OUT" : "GOOD BYE";
      const headColor = isKicked
        ? ctx.createLinearGradient(rX, 0, rX + 420, 0)
        : ctx.createLinearGradient(rX, 0, rX + 420, 0);

      if (isKicked) {
        headColor.addColorStop(0, "#ff6060");
        headColor.addColorStop(0.5, "#ff2060");
        headColor.addColorStop(1, "#ff80a0");
      } else {
        headColor.addColorStop(0, "#c8d8ff");
        headColor.addColorStop(0.5, "#a0c8ff");
        headColor.addColorStop(1, "#80e8ff");
      }

      ctx.font      = `bold 64px ${FONT}`;
      ctx.fillStyle = headColor;
      ctx.shadowColor = isKicked ? "rgba(255,60,60,0.5)" : "rgba(80,160,255,0.5)";
      ctx.shadowBlur  = 24;
      ctx.fillText(headText, rX, cY + 105);
      ctx.shadowBlur = 0;

      // accent underline
      const ulW = ctx.measureText(headText).width * 0.55;
      const ulGrad = ctx.createLinearGradient(rX, 0, rX + ulW, 0);
      ulGrad.addColorStop(0,   isKicked ? "#ff4060" : "#6080ff");
      ulGrad.addColorStop(0.6, isKicked ? "#ff80a0" : "#40d0ff");
      ulGrad.addColorStop(1,   "rgba(255,255,255,0)");
      ctx.strokeStyle = ulGrad; ctx.lineWidth = 3;
      ctx.shadowColor = isKicked ? "rgba(255,60,80,0.8)" : "rgba(60,180,255,0.8)";
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(rX, cY + 118); ctx.lineTo(rX + ulW, cY + 118); ctx.stroke();
      ctx.shadowBlur = 0;

      // Username (with truncation)
      let dispName = userName;
      ctx.font = `bold 40px ${FONT}`;
      const maxNW = W - rX - PAD - 20;
      while (ctx.measureText(dispName).width > maxNW && dispName.length > 3)
        dispName = dispName.slice(0, -1);
      if (dispName !== userName) dispName += "…";

      ctx.fillStyle   = "#ffffff";
      ctx.shadowColor = "rgba(180,200,255,0.4)"; ctx.shadowBlur = 12;
      ctx.fillText(dispName, rX, cY + 180);
      ctx.shadowBlur = 0;

      // Leave type badge
      const badgeText  = isKicked ? "⚡ KICKED FROM GROUP" : "🚪 LEFT THE GROUP";
      const badgeColor = isKicked ? "rgba(255,60,80,0.18)"  : "rgba(60,140,255,0.18)";
      const badgeBorder= isKicked ? "rgba(255,100,120,0.5)" : "rgba(80,180,255,0.5)";
      ctx.font = `600 20px ${FONT}`;
      const bW = ctx.measureText(badgeText).width + 36;
      roundRect(rX, cY + 198, bW, 38, 10);
      ctx.fillStyle   = badgeColor; ctx.fill();
      ctx.strokeStyle = badgeBorder; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle   = isKicked ? "#ff8090" : "#80c8ff";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, rX + 18, cY + 217);
      ctx.textBaseline = "alphabetic";

      // ── Info chips row ────────────────────────────────────────────────────
      const chipY  = cY + 262;
      const chips  = [
        { icon: "👥", label: "MEMBERS", value: `${memberCount}` },
        { icon: "🕐", label: "TIME",    value: `${String(hours).padStart(2,"0")}:${minutes}` },
        { icon: "☀️", label: "SESSION", value: session.toUpperCase() }
      ];
      let chipX = rX;
      ctx.font = `bold 13px ${FONT}`;
      for (const chip of chips) {
        const valW   = ctx.measureText(chip.value).width;
        const chipW  = Math.max(valW + 60, 110);

        roundRect(chipX, chipY, chipW, 64, 12);
        ctx.fillStyle   = "rgba(255,255,255,0.07)"; ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.13)"; ctx.lineWidth = 1; ctx.stroke();

        ctx.textAlign    = "left";
        ctx.textBaseline = "alphabetic";
        ctx.font         = `400 12px ${FONT}`;
        ctx.fillStyle    = "rgba(160,180,220,0.75)";
        ctx.fillText(chip.icon + " " + chip.label, chipX + 12, chipY + 22);

        ctx.font         = `bold 20px ${FONT}`;
        ctx.fillStyle    = "#e0eaff";
        ctx.fillText(chip.value, chipX + 12, chipY + 50);

        chipX += chipW + 14;
      }

      // ── Thread name bar ───────────────────────────────────────────────────
      const tnY = cY + 352;
      roundRect(rX, tnY, W - rX - PAD - 16, 46, 10);
      const tnGrad = ctx.createLinearGradient(rX, tnY, W - PAD, tnY);
      tnGrad.addColorStop(0, "rgba(255,255,255,0.06)");
      tnGrad.addColorStop(1, "rgba(255,255,255,0.02)");
      ctx.fillStyle = tnGrad; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1; ctx.stroke();

      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.font         = `400 13px ${FONT}`;
      ctx.fillStyle    = "rgba(140,160,220,0.7)";
      ctx.fillText("🏠  GROUP", rX + 14, tnY + 14);

      let tnDisp = threadName;
      ctx.font = `bold 17px ${FONT}`;
      const maxTnW = W - rX - PAD - 40;
      while (ctx.measureText(tnDisp).width > maxTnW && tnDisp.length > 3)
        tnDisp = tnDisp.slice(0, -1);
      if (tnDisp !== threadName) tnDisp += "…";
      ctx.fillStyle = "#c8d8ff";
      ctx.fillText(tnDisp, rX + 14, tnY + 34);
      ctx.textBaseline = "alphabetic";

      // ── Watermark ─────────────────────────────────────────────────────────
      ctx.textAlign  = "right";
      ctx.font       = `400 12px ${FONT}`;
      ctx.fillStyle  = "rgba(180,190,255,0.35)";
      ctx.fillText("Powered by MA M UN  ✦  v3.0", W - PAD - 10, H - 22);

      // ── Corner hex ornaments ──────────────────────────────────────────────
      const accentA = isKicked ? "rgba(255,80,100,0.45)" : "rgba(80,160,255,0.45)";
      ctx.strokeStyle = accentA; ctx.lineWidth = 1.2;
      for (const [cx, cy] of [[20,20],[W-20,20],[20,H-20],[W-20,H-20]]) {
        hexPath(cx, cy, 10); ctx.stroke();
      }

      // ── Save & send ───────────────────────────────────────────────────────
      cachePath = path.join(cacheDir, `leave_${leftParticipantFbId}_${Date.now()}.png`);
      await fs.writeFile(cachePath, canvas.toBuffer("image/png"));

      await message.reply({
        body:       leaveMessage,
        attachment: fs.createReadStream(cachePath)
      });

    } catch (err) {
      console.error("[leave] Card generation failed:", err);
      await message.reply(leaveMessage);
    } finally {
      if (cachePath) {
        try { await fs.unlink(cachePath); } catch (_) {}
      }
    }
  }
};
	  
