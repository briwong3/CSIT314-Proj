
class DesignerController {
    constructor(db) {
        this.db = db;
    }

    async designer(id) {
        const [profile, company, projects] = await Promise.all([
            this.db.from('profiles')
                .select('id,name,role,avatar_url')
                .eq('id', id)
                .single(),

            this.db.from('companies')
                .select('*')
                .eq('designer_id', id)
                .maybeSingle(),

            this.db.from('projects')
                .select('*, categories(name)')
                .eq('designer_id', id)
                .order('created_at', { ascending: false })
        ]);

        if (profile.error) throw profile.error;
        if (company.error) throw company.error;
        if (projects.error) throw projects.error;

        return {
            profile: profile.data,
            company: company.data,
            projects: projects.data
        };
    }
}

module.exports = DesignerController;
