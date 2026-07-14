/**
 * Reset / seed the default SwiftPOS admin account.
 *
 * Credentials come from env (never hardcoded):
 *   ADMIN_EMAIL     optional, defaults to admin@swiftpos.co.ke
 *   ADMIN_PASSWORD  required — the script refuses to run without it
 *
 * Run from repo root:
 *   ADMIN_PASSWORD='<strong-password>' pnpm --filter server tsx src/scripts/reset-admin.ts
 */
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path   from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { supabase } from '../lib/supabase';

const EMAIL    = process.env.ADMIN_EMAIL ?? 'admin@swiftpos.co.ke';
const PASSWORD = process.env.ADMIN_PASSWORD;

async function run() {
  if (!PASSWORD || PASSWORD.length < 10) {
    console.error('❌ Set ADMIN_PASSWORD (min 10 chars) in the environment before running this script.');
    process.exit(1);
  }
  console.log(`\nHashing password for ${EMAIL}…`);
  const hash = await bcrypt.hash(PASSWORD, 12);

  const { data, error } = await supabase
    .from('admin_users')
    .upsert(
      {
        email:         EMAIL,
        name:          'SwiftPOS Admin',
        password_hash: hash,
        role:          'super_admin',
        is_active:     true,
      },
      { onConflict: 'email' }
    )
    .select('id, email, role')
    .single();

  if (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }

  console.log('✅ Admin user ready:');
  console.log(`   ID:    ${data.id}`);
  console.log(`   Email: ${data.email}`);
  console.log(`   Role:  ${data.role}`);
  console.log('\n   Password set from ADMIN_PASSWORD env — store it in your password manager.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
