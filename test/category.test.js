
const CategoryController = require('../category');

//Create Category
describe('Platform Manager - Create Category', () => {

    let mockDb;
    let categoryController;

    beforeEach(() => {
        mockDb = {
            from: jest.fn().mockReturnValue({
                insert: jest.fn().mockResolvedValue({
                    data: null,
                    error: null
                })
            })
        };

        categoryController = new CategoryController(mockDb);
    });

    test('should successfully create a new category', async () => {

        const newCategory = {
            name: 'Modern',
            description: 'Modern interior design style'
        };

        await categoryController.createCategory(newCategory);

        expect(mockDb.from).toHaveBeenCalledWith('categories');

        expect(mockDb.from('categories').insert)
            .toHaveBeenCalledWith(newCategory);
    });

    test('should return an error if category creation fails', async () => {

        const error = new Error('Category creation failed');

        mockDb.from.mockReturnValue({
            insert: jest.fn().mockResolvedValue({
                data: null,
                error: error
            })
        });

        await expect(
            categoryController.createCategory({
                name: 'Modern',
                description: 'Modern interior design style'
            })
        ).rejects.toThrow('Category creation failed');

    });

});


//Delete Category
describe('Platform Manager - Delete Category', () => {

    let mockDb;
    let categoryController;

    beforeEach(() => {
        mockDb = {
            rpc: jest.fn()
                .mockResolvedValue({
                    data: [{ projects: 2, drafts: 1 }],
                    error: null
                })
        };

        categoryController = new CategoryController(mockDb);
    });

    test('should check how many projects and drafts use a category', async () => {

        await categoryController.categoryUsage('5');

        expect(mockDb.rpc).toHaveBeenCalledWith(
            'platform_category_usage',
            { p_category_id: 5 }
        );

    });

    test('should move projects and delete the selected category', async () => {

        await categoryController.moveAndDeleteCategory(5, 2);

        expect(mockDb.rpc).toHaveBeenCalledWith(
            'platform_move_and_delete_category',
            {
                p_category_id: 5,
                p_target_category_id: 2
            }
        );

    });

    test('should allow deleting a category without moving projects', async () => {

        await categoryController.moveAndDeleteCategory(5, null);

        expect(mockDb.rpc).toHaveBeenCalledWith(
            'platform_move_and_delete_category',
            {
                p_category_id: 5,
                p_target_category_id: null
            }
        );

    });

    test('should return an error if category deletion fails', async () => {

        mockDb.rpc.mockResolvedValue({
            data: null,
            error: new Error('Category deletion failed')
        });

        await expect(
            categoryController.moveAndDeleteCategory(5, 2)
        ).rejects.toThrow('Category deletion failed');

    });

});
