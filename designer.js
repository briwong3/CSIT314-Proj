(function (root, factory) {
  const DesignerPortfolioController = factory();
  if (typeof module === 'object' && module.exports) module.exports = DesignerPortfolioController;
  else root.DesignerPortfolioController = DesignerPortfolioController;
})(globalThis, function () {
  const must = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  return class DesignerPortfolioController {
    constructor(db) {
      this.db = db;
    }

    async designer(id) {
      const profile = must(await this.db.from('profiles').select('id,name').eq('id', id).single());
      const company = must(await this.db.from('companies').select('*')
        .eq('designer_id', id).maybeSingle());
      const projects = must(await this.db.from('projects').select('*, categories(name)')
        .eq('designer_id', id).order('created_at', { ascending: false }));
      return { profile, company, projects };
    }
  };
});
