import pg from "pg";
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const steps = [
  // 1. Add FK on events.community_id → communities.id (safe: existing values are NULL)
  {
    label: "Add FK events.community_id → communities.id",
    check: `
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'events'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND ccu.column_name = 'community_id'
        AND ccu.table_name = 'communities'
    `,
    sql: `
      ALTER TABLE events
        ADD CONSTRAINT events_community_id_fk
        FOREIGN KEY (community_id)
        REFERENCES communities(id)
        ON DELETE SET NULL
    `,
  },
  // 2. Add check constraint on community_memberships.role
  {
    label: "Add role CHECK constraint on community_memberships",
    check: `
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'community_memberships'
        AND constraint_name = 'role_check'
        AND constraint_type = 'CHECK'
    `,
    sql: `
      ALTER TABLE community_memberships
        ADD CONSTRAINT role_check
        CHECK (role IN ('owner', 'moderator', 'member'))
    `,
  },
  // 3. Add notifications_enabled column to community_memberships
  {
    label: "Add notifications_enabled column to community_memberships",
    check: `
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'community_memberships'
        AND column_name = 'notifications_enabled'
    `,
    sql: `
      ALTER TABLE community_memberships
        ADD COLUMN notifications_enabled boolean NOT NULL DEFAULT true
    `,
  },
  // 5. Allow NULL phone_number in safety_buddies (app-only buddies have no phone)
  {
    label: "Allow NULL phone_number in safety_buddies",
    check: `
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'safety_buddies'
        AND column_name = 'phone_number'
        AND is_nullable = 'YES'
    `,
    sql: `
      ALTER TABLE safety_buddies ALTER COLUMN phone_number DROP NOT NULL
    `,
  },
  // 6. Add unread_count to conversation_participants (denorm — avoids COUNT at read time)
  {
    label: "Add unread_count column to conversation_participants",
    check: `
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'conversation_participants'
        AND column_name = 'unread_count'
    `,
    sql: `
      ALTER TABLE conversation_participants
        ADD COLUMN unread_count integer NOT NULL DEFAULT 0
    `,
  },
  // 7. Add last_message_preview to conversations (denorm — avoids join on inbox list)
  {
    label: "Add last_message_preview column to conversations",
    check: `
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'conversations'
        AND column_name = 'last_message_preview'
    `,
    sql: `
      ALTER TABLE conversations
        ADD COLUMN last_message_preview text
    `,
  },
  // 4. Pre-existing: add unique constraint on post_mentions(post_id, mentioned_user_id)
  {
    label: "Add unique constraint on post_mentions(post_id, mentioned_user_id)",
    check: `
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'post_mentions'
        AND constraint_name = 'post_mentions_post_id_mentioned_user_id_unique'
        AND constraint_type = 'UNIQUE'
    `,
    sql: `
      ALTER TABLE post_mentions
        ADD CONSTRAINT post_mentions_post_id_mentioned_user_id_unique
        UNIQUE (post_id, mentioned_user_id)
    `,
  },
];

for (const step of steps) {
  process.stdout.write(`  → ${step.label} ... `);
  const already = await client.query(step.check);
  if (already.rowCount > 0) {
    console.log("already exists, skipped");
    continue;
  }
  try {
    await client.query(step.sql);
    console.log("done");
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

await client.end();
