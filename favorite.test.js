
const FavoritesController = require('../favorite');

//Save Favorites
describe('Customer - Save Favourite', () => {

    let mockDb;
    let mockInsert;
    let favoritesController;

    beforeEach(() => {
        mockInsert = jest.fn().mockResolvedValue({
            error: null
        });

        mockDb = {
            from: jest.fn().mockReturnValue({
                insert: mockInsert
            })
        };

        favoritesController = new FavoritesController(mockDb);
    });

    test('should successfully save a project as favourite', async () => {

        await favoritesController.add(10, 'user-123');

        expect(mockDb.from).toHaveBeenCalledWith('favorites');

        expect(mockInsert).toHaveBeenCalledWith({
            project_id: 10,
            user_id: 'user-123'
        });

    });

    test('should ignore duplicate favourite entries', async () => {

        mockInsert.mockResolvedValue({
            error: { code: '23505' }
        });

        await expect(
            favoritesController.add(10, 'user-123')
        ).resolves.toBeUndefined();

    });

    test('should return an error if saving favourite fails', async () => {

        mockInsert.mockResolvedValue({
            error: new Error('Unable to save favourite')
        });

        await expect(
            favoritesController.add(10, 'user-123')
        ).rejects.toThrow('Unable to save favourite');

    });

});


//Delete Favorites
describe('Customer - Delete Favourite', () => {

    let mockDb;
    let mockDelete;
    let mockEq;
    let favoritesController;

    beforeEach(() => {
        mockEq = jest.fn().mockReturnThis();

        mockDelete = jest.fn().mockReturnValue({
            eq: mockEq
        });

        mockDb = {
            from: jest.fn().mockReturnValue({
                delete: mockDelete
            })
        };

        // Make the final query return a successful response.
        mockEq.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
                error: null
            })
        }));

        favoritesController = new FavoritesController(mockDb);
    });

    test('should successfully remove a project from favourites', async () => {

        await favoritesController.remove(10, 'user-123');

        expect(mockDb.from).toHaveBeenCalledWith('favorites');
        expect(mockDelete).toHaveBeenCalled();

    });

    test('should return an error if deleting favourite fails', async () => {

        mockEq.mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({
                error: new Error('Unable to delete favourite')
            })
        }));

        await expect(
            favoritesController.remove(10, 'user-123')
        ).rejects.toThrow('Unable to delete favourite');

    });

});
