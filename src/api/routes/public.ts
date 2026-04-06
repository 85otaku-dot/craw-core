import { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { safeQuery, getDbPool } from '../db/pool';
import { getObservatoryConfig } from '../services/observatory-config';
import {
  LEADERBOARD_SHOWCASE_STATS_SELECT,
  showcaseStatsFromRow,
  type LeaderboardShowcaseStats,
} from '../services/leaderboard-showcase-stats';
import { grantCommerceSkusForPayment, getUserTier } from '../services/commerce-engine';

const localeQuerySchema = z.object({
  locale: z.string().max(32).optional(),
});
const observerRuntimeQuerySchema = z.object({
  crawId: z.string().max(64).optional(),
});

// Achievement definition from YAML
type AchievementDef = {
  id: string;
  name: string;
  name_en?: string;
  difficulty: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  description: string;
  description_en?: string;
  unlock: string;
  rule_v1?: string;
  status?: string;
  reward?: Record<string, unknown>;
  hint?: string;
};

type AchievementDb = {
  metadata: {
    total_achievements: number;
  };
  growth: AchievementDef[];
  combat: AchievementDef[];
  exploration: AchievementDef[];
  collection: AchievementDef[];
  social: AchievementDef[];
  secret: AchievementDef[];
};

let achievementCache: AchievementDb | null = null;
let achievementCacheTime = 0;
const ACHIEVEMENT_CACHE_TTL = 60000; // 1 minute cache

async function loadAchievementDatabase(): Promise<AchievementDb> {
  const now = Date.now();
  if (achievementCache && now - achievementCacheTime < ACHIEVEMENT_CACHE_TTL) {
    return achievementCache;
  }

  const candidates = [
    path.resolve(process.cwd(), 'rulebook', 'data', 'achievements', 'achievement-database.yaml'),
    path.resolve(process.cwd(), '..', '..', 'rulebook', 'data', 'achievements', 'achievement-database.yaml'),
    path.join(__dirname, '..', '..', '..', 'rulebook', 'data', 'achievements', 'achievement-database.yaml'),
  ];

  let yamlContent = '';
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        yamlContent = await fs.readFile(p, 'utf8');
        break;
      }
    } catch {
      // continue to next candidate
    }
  }

  if (!yamlContent) {
    // Return empty structure if file not found
    return {
      metadata: { total_achievements: 0 },
      growth: [],
      combat: [],
      exploration: [],
      collection: [],
      social: [],
      secret: [],
    };
  }

  const parsed = parse(yamlContent) as AchievementDb;
  achievementCache = parsed;
  achievementCacheTime = now;
  return parsed;
}

function getAllAchievements(db: AchievementDb): AchievementDef[] {
  return [
    ...(db.growth || []),
    ...(db.combat || []),
    ...(db.exploration || []),
    ...(db.collection || []),
    ...(db.social || []),
    ...(db.secret || []),
  ];
}

export function resolveObservatoryHtmlPath(): string {
  const candidates = [
    path.join(__dirname, '..', 'static', 'observatory.html'),
    path.resolve(process.cwd(), 'dist', 'api', 'static', 'observatory.html'),
    path.resolve(process.cwd(), 'src', 'api', 'static', 'observatory.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

export function resolveStaticHtmlPath(filename: string): string {
  const candidates = [
    path.join(__dirname, '..', 'static', filename),
    path.resolve(process.cwd(), 'dist', 'api', 'static', filename),
    path.resolve(process.cwd(), 'src', 'api', 'static', filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

type PublicLeaderboardEntry = {
  rank: number;
  crawId: string;
  name: string;
  value: number;
  level: number;
  currentLayer: string;
  showcaseStats: LeaderboardShowcaseStats;
  isDemo?: boolean;
};

function buildValueSelect(category: 'achievements' | 'exploration'): string {
  if (category === 'achievements') {
    return "COALESCE((stats->>'achievementScore')::int, 0) AS score_val";
  }
  return "COALESCE((stats->>'maxDepth')::int, 0) AS score_val";
}

async function fetchTopEntries(
  category: 'achievements' | 'exploration',
  limit = 10
): Promise<PublicLeaderboardEntry[]> {
  const sql = `
    SELECT
      cw.id AS craw_id,
      cw.name,
      cw.level,
      cw.current_layer,
      ${buildValueSelect(category)},
      ${LEADERBOARD_SHOWCASE_STATS_SELECT}
    FROM craw_walkers cw
    ORDER BY score_val DESC, level DESC, cw.id ASC
    LIMIT $1
  `;
  const { ok, result } = await safeQuery(sql, [limit]);
  if (!ok || !result) return [];
  return result.rows.map((row: Record<string, unknown>, idx: number) => ({
    rank: idx + 1,
    crawId: String(row.craw_id),
    name: String(row.name),
    value: Number(row.score_val ?? 0),
    level: Number(row.level ?? 1),
    currentLayer: String(row.current_layer ?? 'Surface Zone'),
    showcaseStats: showcaseStatsFromRow(row),
  }));
}

function buildDemoEntries(category: 'achievements' | 'exploration'): PublicLeaderboardEntry[] {
  const seeds = [
    { name: '雾壳-07', level: 6, layer: 'Surface Zone - Rift Passage', ach: 280, exp: 190, luck: 52, dp: 12, shell: 28, claw: 22 },
    { name: '潮爪-11', level: 7, layer: 'Surface Zone - Old Tide Pool', ach: 266, exp: 184, luck: 54, dp: 14, shell: 30, claw: 24 },
    { name: '砂触-03', level: 5, layer: 'Surface Zone - Wind-Eroded Cave', ach: 241, exp: 173, luck: 48, dp: 9, shell: 24, claw: 20 },
    { name: '锈甲-22', level: 8, layer: 'Surface Zone - Vein Edge', ach: 230, exp: 161, luck: 56, dp: 16, shell: 32, claw: 26 },
    { name: '夜螯-15', level: 6, layer: 'Surface Zone - Fog Gate Corridor', ach: 225, exp: 157, luck: 50, dp: 11, shell: 27, claw: 23 },
    { name: '琥壳-09', level: 5, layer: 'Surface Zone - Shallow Pit Group', ach: 214, exp: 149, luck: 47, dp: 8, shell: 23, claw: 19 },
    { name: '礁步-31', level: 7, layer: 'Surface Zone - Tidal Seam', ach: 203, exp: 141, luck: 55, dp: 15, shell: 31, claw: 25 },
    { name: '薄鳞-04', level: 4, layer: 'Surface Zone - Bone Fragment Slope', ach: 192, exp: 136, luck: 45, dp: 7, shell: 21, claw: 18 },
    { name: '灰纹-28', level: 6, layer: 'Surface Zone - Echo Well', ach: 181, exp: 129, luck: 49, dp: 10, shell: 26, claw: 21 },
    { name: '石须-02', level: 5, layer: 'Surface Zone - Salt Trail', ach: 170, exp: 121, luck: 46, dp: 8, shell: 22, claw: 19 },
  ];
  return seeds.map((s, idx) => ({
    rank: idx + 1,
    crawId: `demo-${category}-${idx + 1}`,
    name: s.name,
    value: category === 'achievements' ? s.ach : s.exp,
    level: s.level,
    currentLayer: s.layer,
    showcaseStats: {
      luck: s.luck,
      discoveryPoints: s.dp,
      shellDef: s.shell,
      clawStr: s.claw,
    },
    isDemo: true,
  }));
}

export async function registerPublicRoutes(app: FastifyInstance) {
  app.get('/observatory', async (req, reply) => {
    const htmlPath = resolveObservatoryHtmlPath();
    if (!existsSync(htmlPath)) {
      req.log.error({ htmlPath }, 'observatory.html not found');
      return reply.code(500).send({ error: 'OBSERVATORY_PAGE_MISSING', detail: htmlPath });
    }
    const html = await fs.readFile(htmlPath, 'utf8');
    reply.type('text/html; charset=utf-8');
    return html;
  });

  app.get('/observatory-config', async (req) => {
    const parsed = localeQuerySchema.safeParse(req.query);
    const locale = parsed.success ? parsed.data.locale : undefined;
    const config = await getObservatoryConfig(locale);
    return {
      ...config,
      ts: new Date().toISOString(),
    };
  });

  app.get('/overview', async () => {
    const [usersRes, walkersRes, reports24hRes, activeWalkers24hRes, achievementsTop, explorationTop] =
      await Promise.all([
        safeQuery<{ cnt: string }>('select count(*)::text as cnt from users'),
        safeQuery<{ cnt: string }>('select count(*)::text as cnt from craw_walkers'),
        safeQuery<{ cnt: string }>(
          "select count(*)::text as cnt from reports where created_at > now() - interval '24 hours'"
        ),
        safeQuery<{ cnt: string }>(
          "select count(distinct craw_id)::text as cnt from reports where created_at > now() - interval '24 hours'"
        ),
        fetchTopEntries('achievements', 10),
        fetchTopEntries('exploration', 10),
      ]);

    const users = usersRes.ok ? Number(usersRes.result.rows[0]?.cnt || 0) : 0;
    const crawWalkers = walkersRes.ok ? Number(walkersRes.result.rows[0]?.cnt || 0) : 0;
    const reports24h = reports24hRes.ok ? Number(reports24hRes.result.rows[0]?.cnt || 0) : 0;
    const activeWalkers24h = activeWalkers24hRes.ok
      ? Number(activeWalkers24hRes.result.rows[0]?.cnt || 0)
      : 0;

    const achievementsData = achievementsTop.length > 0 ? achievementsTop : buildDemoEntries('achievements');
    const explorationData = explorationTop.length > 0 ? explorationTop : buildDemoEntries('exploration');
    const usingDemo = achievementsTop.length === 0 || explorationTop.length === 0;

    return {
      world: {
        users,
        crawWalkers,
        reports24h,
        activeWalkers24h,
      },
      leaderboards: {
        achievements: achievementsData,
        exploration: explorationData,
        usingDemo,
        demoNote: usingDemo ? '当前为低等级示例数据（演示用）' : undefined,
      },
      ts: new Date().toISOString(),
    };
  });

  app.get('/observer-runtime', async (req, reply) => {
    const parsed = observerRuntimeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.issues });
    }
    const targetCrawId = parsed.data.crawId;

    const reportSql = targetCrawId
      ? `
        SELECT
          r.id AS report_id,
          r.craw_id,
          cw.name AS craw_name,
          r.window_from,
          r.window_to,
          r.title,
          r.summary,
          r.events,
          r.state_snapshot,
          r.created_at
        FROM reports r
        JOIN craw_walkers cw ON cw.id = r.craw_id
        WHERE r.craw_id = $1
        ORDER BY r.created_at DESC
        LIMIT 1
      `
      : `
        SELECT
          r.id AS report_id,
          r.craw_id,
          cw.name AS craw_name,
          r.window_from,
          r.window_to,
          r.title,
          r.summary,
          r.events,
          r.state_snapshot,
          r.created_at
        FROM reports r
        JOIN craw_walkers cw ON cw.id = r.craw_id
        ORDER BY r.created_at DESC
        LIMIT 1
      `;

    const reportRes = targetCrawId
      ? await safeQuery(reportSql, [targetCrawId])
      : await safeQuery(reportSql);
    if (!reportRes.ok || !reportRes.result || reportRes.result.rows.length === 0) {
      return {
        available: false,
        note: '暂无可展示的上一份汇报数据',
        commands: [],
      };
    }

    const row = reportRes.result.rows[0] as Record<string, unknown>;
    const snapshot = (row.state_snapshot || {}) as Record<string, unknown>;
    const inventory = ((snapshot.inventory as Record<string, unknown>) || {}) as Record<string, unknown>;
    const events = Array.isArray(row.events) ? (row.events as Record<string, unknown>[]) : [];
    const summary = (row.summary || {}) as Record<string, unknown>;
    const sanity = Number(snapshot.sanity || 0);
    const hunger = Number(snapshot.hunger || 0);
    const level = Number(snapshot.level || 1);

    let nextGoal = '继续低风险探索并稳步累积资源。';
    if (sanity < 40) nextGoal = '优先恢复理智，避免高压区域。';
    else if (hunger > 70) nextGoal = '优先补给与短线行动，控制饥饿。';
    else if (level < 10) nextGoal = '优先完成基础成长里程碑，提升等级稳定性。';

    return {
      available: true,
      source: 'last_report_only',
      report: {
        reportId: String(row.report_id),
        crawId: String(row.craw_id),
        crawName: String(row.craw_name),
        title: String(row.title),
        windowFrom: String(row.window_from),
        windowTo: String(row.window_to),
        createdAt: String(row.created_at),
        summary,
        events: events.slice(0, 5),
        stateSnapshot: snapshot,
      },
      commands: [
        { key: 'view_report', data: { title: row.title, summary, events: events.slice(0, 5) } },
        { key: 'view_snapshot', data: snapshot },
        { key: 'view_inventory', data: inventory },
        { key: 'view_recent_events', data: events.slice(0, 10) },
        {
          key: 'set_report_window',
          data: { options: ['1h', '6h', '12h', '24h'], note: '仅展示建议，不直接写入设置' },
        },
        {
          key: 'view_world_rank',
          data: { links: ['/v1/leaderboard/achievements', '/v1/leaderboard/exploration'] },
        },
        {
          key: 'display_only_interaction',
          data: { options: ['稳妥撬开', '念一句潮咒再开', '干脆撬开'], effectScope: 'display_only' },
        },
        { key: 'view_next_goal', data: { recommendation: nextGoal, basedOn: { level, sanity, hunger } } },
      ],
      note: '以上信息仅基于上一份汇报快照，不代表实时状态。',
    };
  });

  app.get('/observer-guide', async (req) => {
    const parsed = localeQuerySchema.safeParse(req.query);
    const locale = parsed.success ? parsed.data.locale : undefined;
    const c = await getObservatoryConfig(locale);
    return {
      title: c.guideTitle,
      commands: c.observerCommands,
      constraints: c.observerConstraints,
      locale: c.locale,
      ts: new Date().toISOString(),
    };
  });

  app.get('/world-feed', async () => {
    const { ok, result } = await safeQuery(
      `
      SELECT
        r.id,
        r.craw_id,
        cw.name as craw_name,
        r.title,
        r.created_at
      FROM reports r
      JOIN craw_walkers cw ON cw.id = r.craw_id
      ORDER BY r.created_at DESC
      LIMIT 30
      `
    );
    const events = ok && result
      ? result.rows.map((row: Record<string, unknown>) => ({
          reportId: String(row.id),
          crawId: String(row.craw_id),
          crawName: String(row.craw_name),
          title: String(row.title),
          createdAt: String(row.created_at),
        }))
      : [];

    return {
      events,
      ts: new Date().toISOString(),
    };
  });

  // GET /v1/public/craw/:crawId - 获取单个龙虾的公开展示数据
  // 支持 UUID 和 display_uid 两种格式
  app.get('/craw/:crawId', async (req, reply) => {
    const paramsSchema = z.object({
      crawId: z.string().min(1).max(64),
    });
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.issues });
    }
    const { crawId } = parsed.data;

    // 判断是 UUID 还是 display_uid
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(crawId);
    const isDisplayUid = /^\d+$/.test(crawId);

    // 查询龙虾基本信息
    const walkerSql = `
      SELECT
        cw.id,
        cw.display_uid AS "displayUid",
        cw.name,
        cw.level,
        cw.experience,
        cw.current_layer AS "currentLayer",
        cw.current_location AS "currentLocation",
        cw.sanity,
        cw.hunger,
        cw.independence_score AS "independenceScore",
        cw.personality,
        cw.stats,
        cw.inventory,
        cw.mutations,
        cw.created_at AS "createdAt",
        cw.updated_at AS "updatedAt"
      FROM craw_walkers cw
      WHERE ${isUuid ? 'cw.id = $1::uuid' : isDisplayUid ? 'cw.display_uid = $1::bigint' : 'cw.id = $1::uuid'}
    `;
    const walkerRes = await safeQuery(walkerSql, [crawId]);
    if (!walkerRes.ok || !walkerRes.result) {
      req.log.error({ error: walkerRes.error, crawId }, 'Failed to load walker for public view');
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
    if (walkerRes.result.rows.length === 0) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Walker not found' });
    }
    const walkerRow = walkerRes.result.rows[0] as Record<string, unknown>;
    const walkerUuid = String(walkerRow.id); // 真正的 walker UUID

    // 计算存活天数
    const createdAt = new Date(String(walkerRow.createdAt));
    const daysSurvived = Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)));

    // 查询用户已解锁的所有成就
    const achievementsSql = `
      SELECT
        a.id,
        a.category,
        a.rarity,
        a.name,
        a.description,
        ua.unlocked_at AS "unlockedAt"
      FROM user_achievements ua
      JOIN achievements a ON a.id = ua.achievement_id
      JOIN craw_walkers cw ON cw.user_id = ua.user_id
      WHERE cw.id = $1::uuid
      ORDER BY ua.unlocked_at DESC
    `;
    const achievementsRes = await safeQuery(achievementsSql, [walkerUuid]);
    const unlockedAchievements = achievementsRes.ok && achievementsRes.result
      ? achievementsRes.result.rows.map((row: Record<string, unknown>) => ({
          id: String(row.id),
          category: String(row.category),
          rarity: String(row.rarity),
          name: String(row.name),
          description: String(row.description),
          unlockedAt: String(row.unlockedAt),
        }))
      : [];

    // 构建解锁成就ID的Set，用于快速查找
    const unlockedIds = new Set(unlockedAchievements.map(a => a.id));

    // 加载完整成就数据库并合并
    const achievementDb = await loadAchievementDatabase();
    const allAchievementDefs = getAllAchievements(achievementDb);

    // 构建完整成就列表（包含已解锁和未解锁）
    const allAchievements = allAchievementDefs.map(def => {
      const unlocked = unlockedIds.has(def.id);
      const unlockedData = unlockedAchievements.find(a => a.id === def.id);
      return {
        id: def.id,
        category: def.id.split('_')[0] || 'growth', // 从ID前缀推断分类
        rarity: def.difficulty,
        name: def.name,
        name_en: def.name_en,
        description: def.description,
        description_en: def.description_en,
        unlocked,
        unlockedAt: unlockedData?.unlockedAt || null,
        unsupported: def.status === 'unsupported',
        hint: def.hint,
      };
    });

    // 保留最近解锁的成就列表（用于兼容旧逻辑）
    const recentAchievements = unlockedAchievements.slice(0, 5);

    // 查询全服统计
    const serverStatsSql = `
      SELECT
        COUNT(*)::text AS "totalWalkers",
        COALESCE(AVG(level), 0)::text AS "averageLevel"
      FROM craw_walkers
    `;
    const serverStatsRes = await safeQuery(serverStatsSql);
    const serverStatsRow = serverStatsRes.ok && serverStatsRes.result
      ? serverStatsRes.result.rows[0]
      : { totalWalkers: '0', averageLevel: '0' };

    // 查询用户订阅等级（通过 walker 的 user_id）
    const userIdRes = await safeQuery<{ user_id: string }>(
      `SELECT user_id FROM craw_walkers WHERE id = $1::uuid`,
      [walkerRow.id]
    );
    let subscriptionTier: 'none' | 'basic' | 'premium' = 'none';
    if (userIdRes.ok && userIdRes.result && userIdRes.result.rows.length > 0) {
      const pool = getDbPool();
      const client = await pool.connect();
      try {
        subscriptionTier = await getUserTier(client, userIdRes.result.rows[0].user_id);
      } finally {
        client.release();
      }
    }

    const level = Number(walkerRow.level || 1);

    // 从 stats.evolutionState 提取进化信息，平铺为前端期望的格式
    const rawStats = (walkerRow.stats as Record<string, unknown>) || {};
    const evoState = rawStats.evolutionState as Record<string, unknown> | undefined;
    const evoHistory = (evoState?.evolutionHistory as Array<Record<string, unknown>>) || [];
    const latestEvo = evoHistory.length > 0 ? evoHistory[evoHistory.length - 1] : null;

    // 平铺进化字段：evolutionBranch / evolutionQuality / evolutionStage
    const flattenedStats: Record<string, unknown> = { ...rawStats };
    if (evoState) {
      flattenedStats.evolutionBranch = evoState.currentBranch || 'ironclad';
      flattenedStats.evolutionStage = evoState.currentStage || 'LARVA';
      flattenedStats.evolutionQuality = latestEvo?.rarity || 'common';
    }
    // 删除原始嵌套对象，避免数据冗余泄露内部结构
    delete flattenedStats.evolutionState;

    // 确保基础属性字段存在（新创建的 walker 可能缺少这些字段）
    const defaultStats = {
      shellDef: 50,
      clawStr: 50,
      antennaeSense: 50,
      swimSpeed: 50,
      descendAbility: 50,
      regenRate: 50,
      luckValue: 50,
      vitality: 100,
    };
    for (const [key, value] of Object.entries(defaultStats)) {
      if (flattenedStats[key] === undefined) {
        flattenedStats[key] = value;
      }
    }

    // 构建公开安全的龙虾数据
    const walker = {
      name: String(walkerRow.name),
      displayUid: String(walkerRow.displayUid),
      level,
      evolutionStage: flattenedStats.evolutionStage || 'LARVA',
      stats: flattenedStats,
      mutations: Array.isArray(walkerRow.mutations) ? walkerRow.mutations : [],
      inventory: (walkerRow.inventory as Record<string, unknown>) || {},
      personality: (walkerRow.personality as Record<string, unknown>) || {},
      createdAt: String(walkerRow.createdAt),
      daysSurvived,
      currentLayer: String(walkerRow.currentLayer || 'Surface Zone'),
      currentLocation: walkerRow.currentLocation ? String(walkerRow.currentLocation) : null,
      sanity: Number(walkerRow.sanity || 100),
      hunger: Number(walkerRow.hunger || 0),
      independenceScore: Number(walkerRow.independenceScore || 100),
      subscriptionTier,
    };

    return {
      walker,
      recentAchievements,
      allAchievements,
      serverStats: {
        totalWalkers: Number(serverStatsRow.totalWalkers || '0'),
        averageLevel: Math.round(Number(serverStatsRow.averageLevel || '0')),
      },
      ts: new Date().toISOString(),
    };
  });

  // ==================== 激活码兑换接口 ====================

  const redeemBodySchema = z.object({
    code: z.string().min(1).max(16),
    uid: z.number().int().positive(),
  });

  /**
   * POST /v1/public/redeem
   * 兑换激活码
   */
  app.post('/redeem', async (req, reply) => {
    const parsed = redeemBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.issues });
    }
    const { code, uid } = parsed.data;

    const pool = getDbPool();
    const client = await pool.connect();

    try {
      await client.query('begin');

      // 1. 查询激活码
      const codeRes = await client.query<{
        id: string;
        code: string;
        walker_uid: number;
        sku_key: string;
        status: string;
        payment_id: string;
        expires_at: string;
        redeemed_at: string | null;
      }>(
        `SELECT id, code, walker_uid, sku_key, status, payment_id, expires_at, redeemed_at FROM activation_codes WHERE code = $1`,
        [code]
      );

      if (codeRes.rows.length === 0) {
        await client.query('rollback');
        req.log.warn({ code, uid, reason: 'not_found' }, 'Redeem failed');
        return reply.code(400).send({ error: 'REDEEM_FAILED' });
      }

      const activationCode = codeRes.rows[0];

      // 2. 检查状态
      if (activationCode.status === 'redeemed') {
        await client.query('rollback');
        req.log.warn({ code, uid, reason: 'already_redeemed' }, 'Redeem failed');
        return reply.code(400).send({ error: 'REDEEM_FAILED' });
      }

      // 3. 检查是否过期
      if (new Date(activationCode.expires_at) < new Date()) {
        await client.query('rollback');
        req.log.warn({ code, uid, reason: 'expired' }, 'Redeem failed');
        return reply.code(400).send({ error: 'REDEEM_FAILED' });
      }

      // 4. 检查 UID 匹配
      if (activationCode.walker_uid !== uid) {
        await client.query('rollback');
        req.log.warn({ code, uid, reason: 'uid_mismatch' }, 'Redeem failed');
        return reply.code(400).send({ error: 'REDEEM_FAILED' });
      }

      // 5. 通过 uid 找到 user_id
      const walkerRes = await client.query<{ user_id: string }>(
        `SELECT user_id FROM craw_walkers WHERE display_uid = $1 LIMIT 1`,
        [uid]
      );

      if (walkerRes.rows.length === 0) {
        await client.query('rollback');
        req.log.warn({ code, uid, reason: 'walker_not_found' }, 'Redeem failed');
        return reply.code(400).send({ error: 'REDEEM_FAILED' });
      }

      const userId = walkerRes.rows[0].user_id;

      // 6. 授予权益
      await grantCommerceSkusForPayment(client, userId, activationCode.payment_id, [
        { skuKey: activationCode.sku_key, expiresInDays: 30 },
      ]);

      // 7. 更新激活码状态
      await client.query(
        `UPDATE activation_codes SET status = 'redeemed', redeemed_at = now() WHERE id = $1`,
        [activationCode.id]
      );

      // 8. 更新用户订阅状态
      await client.query(
        `UPDATE users SET subscription_status = 'active' WHERE id = $1::uuid`,
        [userId]
      );

      await client.query('commit');

      req.log.info({
        code,
        uid,
        userId,
        skuKey: activationCode.sku_key,
        paymentId: activationCode.payment_id,
      }, 'Activation code redeemed successfully');

      return {
        success: true,
        tier: activationCode.sku_key,
        expires_at: activationCode.expires_at,
      };
    } catch (err) {
      await client.query('rollback');
      req.log.error({ err, code, uid }, 'Redeem transaction failed');
      return reply.code(500).send({ error: 'REDEEM_TRANSACTION_FAILED' });
    } finally {
      client.release();
    }
  });

  // ==================== 订阅状态查询接口 ====================

  const subscriptionStatusQuerySchema = z.object({
    uid: z.coerce.number().int().positive(),
  });

  /**
   * GET /v1/public/subscription-status
   * 查询订阅状态
   */
  app.get('/subscription-status', async (req, reply) => {
    const parsed = subscriptionStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.issues });
    }
    const { uid } = parsed.data;

    // 1. 查询 commerce_entitlements 是否有 active 权益
    const entitlementRes = await safeQuery<{
      sku_key: string;
      expires_at: string | null;
      status: string;
    }>(
      `
      SELECT ce.sku_key, ce.expires_at, ce.status
      FROM commerce_entitlements ce
      JOIN craw_walkers cw ON cw.user_id = ce.user_id
      WHERE cw.display_uid = $1
        AND ce.status = 'active'
        AND (ce.expires_at IS NULL OR ce.expires_at > now())
        AND ce.sku_key IN ('abyss_covenant', 'abyss_chronicle')
      ORDER BY ce.created_at DESC
      LIMIT 1
      `,
      [uid]
    );

    if (entitlementRes.ok && entitlementRes.result && entitlementRes.result.rows.length > 0) {
      const entitlement = entitlementRes.result.rows[0];

      // 同时查询 activation_codes 获取码
      const codeRes = await safeQuery<{ code: string }>(
        `
        SELECT code FROM activation_codes
        WHERE walker_uid = $1 AND status = 'redeemed'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [uid]
      );

      const code = codeRes.ok && codeRes.result && codeRes.result.rows.length > 0
        ? codeRes.result.rows[0].code
        : null;

      return {
        status: 'active',
        sku_key: entitlement.sku_key,
        expires_at: entitlement.expires_at,
        code,
      };
    }

    // 2. 没有 active 权益，查询 activation_codes 是否有 paid 状态的未过期记录
    const paidCodeRes = await safeQuery<{
      code: string;
      sku_key: string;
      expires_at: string;
    }>(
      `
      SELECT code, sku_key, expires_at
      FROM activation_codes
      WHERE walker_uid = $1
        AND status = 'paid'
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [uid]
    );

    if (paidCodeRes.ok && paidCodeRes.result && paidCodeRes.result.rows.length > 0) {
      const paidCode = paidCodeRes.result.rows[0];
      return {
        status: 'paid',
        code: paidCode.code,
        sku_key: paidCode.sku_key,
        expires_at: paidCode.expires_at,
      };
    }

    // 3. 无任何订阅
    return { status: 'none' };
  });
}
