
class CategoryController {
    constructor(db) {
        this.db = db;
    }

    async createCategory(fields) {
        const { data, error } = await this.db
            .from('categories')
            .insert(fields);

        if (error) {
            throw error;
        }

        return data;
    }

    async categoryUsage(id) {
        const { data, error } = await this.db.rpc(
            'platform_category_usage',
            { p_category_id: Number(id) }
        );

        if (error) {
            throw error;
        }

        return data;
    }

    async moveAndDeleteCategory(id, targetId) {
        const { data, error } = await this.db.rpc(
            'platform_move_and_delete_category',
            {
                p_category_id: Number(id),
                p_target_category_id: targetId == null
                    ? null
                    : Number(targetId)
            }
        );

        if (error) {
            throw error;
        }

        return data;
    }
}

module.exports = CategoryController;
