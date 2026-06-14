/**
 * Reset / seed the default SwiftPOS admin account.
 *
 * Run from repo root:
 *   pnpm --filter server tsx src/scripts/reset-admin.ts
 */
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path   from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { supabase } from '../lib/supabase';

const EMAIL    = 'admin@swiftpos.co.ke';
const PASSWORD = 'SwiftAdmin2026!';

async function run() {
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
  console.log(`   Pass:  ${PASSWORD}`);
  console.log('\n   ⚠️  Change this password on first login.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
