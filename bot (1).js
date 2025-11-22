require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;

const botName = 'BotBoy';
const OWNER = 'syzdark'; // 👑 your Minecraft username (case-sensitive!)
const AUTH_PASSWORD = 'JoemModz'; // 🔑 used for /register and /login
let hasAttemptedAuth = false;

// 🔒 Whisper only to you
function reply(msg) {
  if (msg && typeof msg === 'string') {
    const safeMsg = msg.length > 96 ? msg.substring(0, 93) + "..." : msg;
    bot.whisper(OWNER, safeMsg);
  }
}

let currentAction = null;
let pvpTargetName = null;
let pvpLoopInterval = null;
let isInCombat = false;
let lastGearCheck = 0;
let isConsuming = false;
let isBotDead = false;

const bot = mineflayer.createBot({
  host: 'play.breezemc.fun',
  port: 25565,
  username: botName,
  version: false
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);

const cleanName = (name) => name.replace(/^minecraft:/, '');

// 🧪 Combat potion check
function isCombatPotion(item) {
  const name = cleanName(item.name).toLowerCase();
  return name.includes('potion') && (name.includes('strength') || name.includes('swiftness'));
}

// 🛡️ Equip best gear
async function equipBestGear(force = false) {
  if (isBotDead) return;
  const now = Date.now();
  if (!force && now - lastGearCheck < 1500) return;
  lastGearCheck = now;

  const inv = bot.inventory;
  try {
    const slots = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };
    for (const [slot, type] of Object.entries(slots)) {
      let best = null;
      for (const item of inv.items()) {
        if (cleanName(item.name).includes(type)) {
          if (!best || item.type > best.type) best = item;
        }
      }
      if (best) {
        const current = bot.getEquipmentDestSlot(slot);
        if (!current || current.type !== best.type) {
          if (best.slot < 36) {
            const hb = inv.slots.slice(36, 45).findIndex(s => !s);
            if (hb !== -1) {
              await bot.inventory.move(best.slot, 36 + hb, 1);
              await new Promise(r => setTimeout(r, 40));
            }
          }
          await bot.equip(best, slot).catch(() => {});
        }
      }
    }

    const totem = inv.items().find(i => cleanName(i.name) === 'totem_of_undying');
    const shield = inv.items().find(i => cleanName(i.name) === 'shield');
    const offhand = bot.inventory.slots[45];

    if (totem && (!offhand || cleanName(offhand.name) !== 'totem_of_undying')) {
      const hb = inv.slots.slice(36, 45).findIndex(s => !s);
      if (hb !== -1) {
        await bot.inventory.move(totem.slot, 36 + hb, 1);
        await new Promise(r => setTimeout(r, 40));
        await bot.inventory.move(36 + hb, 45, 1).catch(() => {});
      }
    } else if (shield && (!offhand || cleanName(offhand.name) !== 'shield')) {
      const hb = inv.slots.slice(36, 45).findIndex(s => !s);
      if (hb !== -1) {
        await bot.inventory.move(shield.slot, 36 + hb, 1);
        await new Promise(r => setTimeout(r, 40));
        await bot.inventory.move(36 + hb, 45, 1).catch(() => {});
      }
    }
  } catch (e) {}
}

// 🍎 Heal if critical
async function healIfNeeded() {
  if (isConsuming || isBotDead || (bot.health > 8 && bot.food > 6)) return;
  try {
    if (bot.health < 8) {
      const gapp = bot.inventory.items().find(i =>
        ['golden_apple', 'enchanted_golden_apple'].includes(cleanName(i.name))
      );
      if (gapp) {
        isConsuming = true;
        bot.clearControlStates();
        await bot.equip(gapp, 'hand');
        await bot.consume();
        isConsuming = false;
        return;
      }
    }
    if (bot.food < 6) {
      const edible = bot.inventory.items().filter(i => {
        const data = require('minecraft-data')(bot.version).itemsByName[cleanName(i.name)];
        return data?.food;
      }).sort((a, b) => {
        const A = require('minecraft-data')(bot.version).itemsByName[cleanName(a.name)];
        const B = require('minecraft-data')(bot.version).itemsByName[cleanName(b.name)];
        return (B?.food?.saturation || 0) - (A?.food?.saturation || 0);
      });
      if (edible[0]) {
        isConsuming = true;
        bot.clearControlStates();
        await bot.equip(edible[0], 'hand');
        await bot.consume();
        isConsuming = false;
      }
    }
  } catch (e) {
    isConsuming = false;
  }
}

// 🧪 Use best potion
async function useBestPotion() {
  if (isConsuming || isBotDead) return;
  const potions = bot.inventory.items().filter(isCombatPotion);
  if (potions[0]) {
    isConsuming = true;
    await bot.equip(potions[0], 'hand');
    await bot.consume();
    isConsuming = false;
  }
}

// 🛑 Stop all
function stopAllActions(reason = "") {
  bot.pathfinder.setGoal(null);
  if (pvpLoopInterval) {
    clearInterval(pvpLoopInterval);
    pvpLoopInterval = null;
    bot.pvp.stop();
  }
  bot.clearControlStates();
  currentAction = null;
  pvpTargetName = null;
  isInCombat = false;
  isConsuming = false;
  if (reason) reply(reason);
}

// 👣 Follow
async function startFollow(targetName) {
  if (isBotDead) return;
  const target = bot.players[targetName]?.entity;
  if (!target) return reply(`❌ ${targetName} NOT FOUND!`);
  stopAllActions();
  currentAction = 'follow';
  reply(`👣 FOLLOWING ${targetName}!`);
  await equipBestGear(true);
  const GoalFollow = require('mineflayer-pathfinder').goals.GoalFollow;
  bot.pathfinder.setGoal(new GoalFollow(target, 1.5), true);
}

// 💬 Public chat proxy (only via whisper or public @BotBoy chat)
function proxyChat(msg) {
  bot.chat(msg.trim());
}

// ⚔️ Aggressive PVP
function startPvP(targetName) {
  if (isBotDead) return;
  const target = bot.players[targetName]?.entity;
  if (!target) return reply(`❌ ${targetName} NOT FOUND!`);

  stopAllActions();
  isInCombat = true;
  pvpTargetName = targetName;
  currentAction = 'pvp';
  reply(`👹 HUNTING ${targetName}!`);

  equipBestGear(true);
  useBestPotion();
  isBotDead = false;

  pvpLoopInterval = setInterval(async () => {
    if (bot.health <= 0 || isBotDead) {
      isBotDead = true;
      stopAllActions("☠️ I DIED! Respawn me!");
      return;
    }

    if (currentAction !== 'pvp' || pvpTargetName !== targetName) {
      clearInterval(pvpLoopInterval);
      return;
    }

    const currentTarget = bot.entities[target.id];
    if (!currentTarget?.position) {
      stopAllActions(`✅ ${targetName} GONE.`);
      return;
    }

    await healIfNeeded();
    await equipBestGear();

    const inv = bot.inventory.items();
    let weapon = null;
    const isTargetBlocking = currentTarget?.heldItem?.name?.includes('shield');

    if (isTargetBlocking) {
      weapon = inv.find(i => cleanName(i.name).includes('axe'));
    }
    if (!weapon) {
      weapon = inv.find(i => {
        const n = cleanName(i.name);
        return n.includes('sword') || n.includes('axe') || n.includes('trident');
      });
    }

    if (weapon) {
      try {
        if (weapon.slot < 36) {
          const hb = bot.inventory.slots.slice(36, 45).findIndex(s => !s);
          if (hb !== -1) {
            await bot.inventory.move(weapon.slot, 36 + hb, 1);
            await new Promise(r => setTimeout(r, 30));
          }
        }
        await bot.equip(weapon, 'hand').catch(() => {});
      } catch (e) {}
    }

    if (isConsuming) {
      bot.clearControlStates();
      return;
    }

    bot.clearControlStates();
    const dist = bot.entity.position.distanceTo(currentTarget.position);
    if (dist > 2.5) {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
    } else {
      if (Math.random() > 0.6) bot.setControlState('jump', true);
      bot.setControlState('left', Math.random() > 0.5);
      bot.setControlState('right', Math.random() > 0.5);
    }

    bot.pvp.attack(currentTarget);

    if (currentTarget.health !== undefined && currentTarget.health <= 0) {
      stopAllActions(`✅ ${targetName} DELETED!`);
    }
  }, 250);
}

// 🎯 Public chat (only for @BotBoy chat...)
bot.on('chat', async (username, message) => {
  if (username === bot.username || isBotDead) return;
  const proxy = message.match(new RegExp(`^@${botName}\\s+chat\\s+(.+)$`, 'i'));
  if (proxy) return proxyChat(proxy[1]);
});

// 🔐 Private commands via /msg BotBoy ...
bot.on('whisper', async (username, message) => {
  // Optional: restrict to OWNER only
  // if (username.toLowerCase() !== OWNER.toLowerCase()) return;

  const msg = message.trim();

  if (/^help\b/i.test(msg)) {
    reply("👹 pvp @<player>");
    reply("👣 follow @<player>");
    reply("🗨️ chat <msg>");
    reply("🛑 stop");
    return;
  }

  if (/^stop\b/i.test(msg)) return stopAllActions();

  const followMatch = msg.match(/^follow\s+@([a-zA-Z0-9_]+)$/i);
  if (followMatch) return startFollow(followMatch[1]);

  const pvpMatch = msg.match(/^pvp\s+@([a-zA-Z0-9_]+)$/i);
  if (pvpMatch) return startPvP(pvpMatch[1]);

  const chatMatch = msg.match(/^chat\s+(.+)$/i);
  if (chatMatch) return proxyChat(chatMatch[1]);

  reply("❓ Unknown. Type 'help'");
});

// 🔑 AUTO LOGIN / REGISTER (runs once after spawn)
bot.on('spawn', () => {
  isBotDead = false;

  // Setup pathfinder
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.canBreak = false;
  defaultMove.sprint = true;
  bot.pathfinder.setMovements(defaultMove);

  reply("✅ BACK FROM HELL. READY.");

  // ⏳ Auto-auth (only once)
  if (!hasAttemptedAuth) {
    hasAttemptedAuth = true;
    setTimeout(() => {
      reply("🔑 Auto-authenticating...");
      bot.chat(`/register ${AUTH_PASSWORD} ${AUTH_PASSWORD}`);
      setTimeout(() => {
        bot.chat(`/login ${AUTH_PASSWORD}`);
        reply("🔑 Auth sent.");
      }, 1000);
    }, 3000); // Wait 3s after spawn
  }
});

// 🩸 Death detection
bot.on('death', () => {
  isBotDead = true;
  reply("☠️ I DIED! Waiting to respawn...");
});

// 🧠 Background loop
setInterval(() => {
  if (isBotDead) return;
  if (bot.health <= 1) healIfNeeded().catch(() => {});
  if (!isInCombat) {
    equipBestGear().catch(() => {});
    healIfNeeded().catch(() => {});
  }
}, 1800);

bot.on('consume', () => isConsuming = false);

bot.on('error', (err) => {
  if (!err.message.includes('PartialReadError')) {
    reply(`❌ ERROR: ${err.message}`);
  }
});