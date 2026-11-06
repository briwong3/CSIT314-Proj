// Edge Function: privileged user management (create / delete / reset password). Deploy: supabase functions deploy admin-users
// @ts-ignore Deno resolves npm: dependencies; non-Deno TypeScript servers may not.
import { createClient } from 'npm:@supabase/supabase-js@2';
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

class AdminService {
  private db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  async assertAdmin(req: Request): Promise<string> {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await this.db.auth.getUser(token);
    if (!user) throw new Error('Not signed in');
    const { data: p } = await this.db.from('profiles').select('role,status').eq('id', user.id).single();
    if (p?.role !== 'admin' || p.status !== 'active') throw new Error('Forbidden');
    return user.id;
  }
  async deleteSelf(req: Request): Promise<void> {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user }, error: authError } = await this.db.auth.getUser(token);
    if (authError || !user) throw new Error('Not signed in');
    const { data: profile, error: profileError } = await this.db.from('profiles')
      .select('role,status').eq('id', user.id).single();
    if (profileError) throw profileError;
    if (!profile || !['customer', 'designer'].includes(profile.role) || profile.status !== 'active') {
      throw new Error('Only active customer and interior designer accounts can delete themselves.');
    }
    const { error } = await this.db.auth.admin.deleteUser(user.id);
    if (error) throw error;
  }
  private async log(actor: string, action: string, detail: string) {
    const { error } = await this.db.from('audit_logs').insert({ actor, action, detail });
    if (error) throw error;
  }

  async handle(b: any, actor: string) {
    switch (b.action) {
      case 'create': {
        if (!b.name?.trim() || !b.email?.trim()) throw new Error('Name and email are required');
        if (!['admin', 'designer', 'customer', 'platform'].includes(b.role)) throw new Error('Invalid profile');
        if (!['active', 'suspended'].includes(b.status)) throw new Error('Invalid account status');
        if (!b.invite && (!b.password || b.password.length < 6)) throw new Error('A password of at least 6 characters is required');
        const options = { data: { name: b.name.trim(), role: b.role } };
        const { data, error } = b.invite
          ? await this.db.auth.admin.inviteUserByEmail(b.email.trim(), options)
          : await this.db.auth.admin.createUser({ email: b.email.trim(), password: b.password, email_confirm: true, user_metadata: options.data });
        if (error) throw error;
        const { error: profileError } = await this.db.from('profiles')
          .update({ role: b.role, name: b.name.trim(), email: b.email.trim(), status: b.status })
          .eq('id', data.user.id);
        if (profileError) throw profileError;
        return this.log(actor, 'CREATE_USER', `${b.email.trim()} as ${b.role}; status=${b.status}; invite=${Boolean(b.invite)}`);
      }
      case 'edit': {
        if (!b.id || !b.name?.trim() || !b.email?.trim()) throw new Error('Name and email are required');
        if (!['admin', 'designer', 'customer', 'platform'].includes(b.role)) throw new Error('Invalid profile');
        if (!['active', 'suspended'].includes(b.status)) throw new Error('Invalid account status');
        if (b.id === actor && (b.role !== 'admin' || b.status !== 'active')) {
          throw new Error('You cannot change your own admin profile or account status');
        }
        const { data: current, error: lookupError } = await this.db.auth.admin.getUserById(b.id);
        if (lookupError) throw lookupError;
        if (!current.user) throw new Error('Account not found');
        if (current.user.email !== b.email.trim()) {
          const { error } = await this.db.auth.admin.updateUserById(b.id, { email: b.email.trim(), email_confirm: true });
          if (error) throw error;
        }
        const { error: profileError } = await this.db.from('profiles')
          .update({ name: b.name.trim(), email: b.email.trim(), role: b.role, status: b.status })
          .eq('id', b.id);
        if (profileError) throw profileError;
        return this.log(actor, 'UPDATE_USER', `${b.email.trim()}: role=${b.role}, status=${b.status}, name=${b.name.trim()}`);
      }
      case 'delete': {
        if (b.id === actor) throw new Error('Admins cannot delete themselves');
        const { error } = await this.db.auth.admin.deleteUser(b.id); if (error) throw error;
        return this.log(actor, 'DELETE_USER', b.id);
      }
      case 'status': {
        if (!b.id) throw new Error('Account ID is required');
        if (!['active', 'suspended'].includes(b.status)) throw new Error('Invalid account status');
        if (b.id === actor && b.status !== 'active') throw new Error('You cannot suspend your own admin account');
        const { data: profile, error: lookupError } = await this.db.from('profiles').select('name,email').eq('id', b.id).single();
        if (lookupError) throw lookupError;
        const { error } = await this.db.from('profiles').update({ status: b.status }).eq('id', b.id);
        if (error) throw error;
        const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
        return this.log(actor, b.status === 'suspended' ? 'SUSPEND_USER' : 'REACTIVATE_USER',
          `${profile.email ?? profile.name}: ${b.status}${reason ? `; reason=${reason}` : ''}`);
      }
      case 'reset': {
        const { error } = await this.db.auth.admin.updateUserById(b.id, { password: b.password }); if (error) throw error;
        return this.log(actor, 'RESET_PASSWORD', b.id);
      }
      default: throw new Error('Unknown action');
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const svc = new AdminService();
  try {
    const body = await req.json();
    if (body.action === 'self-delete') {
      await svc.deleteSelf(req);
    } else {
      const actor = await svc.assertAdmin(req);
      await svc.handle(body, actor);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});