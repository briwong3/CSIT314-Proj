
const DesignerController = require('../designer');

//View Portfolio
describe('Interior Designer - View Portfolio', () => {

    let mockDb;
    let designerController;

    const profileData = {
        id: 'designer-123',
        name: 'John Designer',
        role: 'designer',
        avatar_url: null
    };

    const companyData = {
        id: 1,
        designer_id: 'designer-123',
        name: 'Modern Living Studio',
        bio: 'Interior design company'
    };

    const projectData = [
        {
            id: 1,
            title: 'Modern Living Room',
            designer_id: 'designer-123',
            visibility: 'published'
        },
        {
            id: 2,
            title: 'Classic Bedroom',
            designer_id: 'designer-123',
            visibility: 'published'
        }
    ];

    beforeEach(() => {

        const profileQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
                data: profileData,
                error: null
            })
        };

        const companyQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
                data: companyData,
                error: null
            })
        };

        const projectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
                data: projectData,
                error: null
            })
        };

        mockDb = {
            from: jest.fn((table) => {
                if (table === 'profiles') return profileQuery;
                if (table === 'companies') return companyQuery;
                if (table === 'projects') return projectQuery;
            })
        };

        designerController = new DesignerController(mockDb);
    });

    test('should retrieve the designer profile', async () => {

        const result = await designerController.designer('designer-123');

        expect(result.profile).toEqual(profileData);
        expect(mockDb.from).toHaveBeenCalledWith('profiles');

    });

    test('should retrieve the designer company information', async () => {

        const result = await designerController.designer('designer-123');

        expect(result.company).toEqual(companyData);
        expect(mockDb.from).toHaveBeenCalledWith('companies');

    });

    test('should retrieve both new and older portfolio projects', async () => {

        const result = await designerController.designer('designer-123');

        expect(result.projects).toHaveLength(2);

        expect(result.projects).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    title: 'Modern Living Room'
                }),
                expect.objectContaining({
                    title: 'Classic Bedroom'
                })
            ])
        );

        expect(mockDb.from).toHaveBeenCalledWith('projects');

    });

    test('should return an empty project list when the designer has no projects', async () => {

        const emptyProjectQuery = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
                data: [],
                error: null
            })
        };

        mockDb.from.mockImplementation((table) => {
            if (table === 'profiles') {
                return {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    single: jest.fn().mockResolvedValue({
                        data: profileData,
                        error: null
                    })
                };
            }

            if (table === 'companies') {
                return {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    maybeSingle: jest.fn().mockResolvedValue({
                        data: companyData,
                        error: null
                    })
                };
            }

            if (table === 'projects') return emptyProjectQuery;
        });

        const result = await designerController.designer('designer-123');

        expect(result.projects).toEqual([]);

    });

    test('should return an error if retrieving the designer profile fails', async () => {

        mockDb.from.mockImplementation((table) => {
            if (table === 'profiles') {
                return {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    single: jest.fn().mockResolvedValue({
                        data: null,
                        error: new Error('Unable to retrieve designer profile')
                    })
                };
            }

            if (table === 'companies') {
                return {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    maybeSingle: jest.fn().mockResolvedValue({
                        data: companyData,
                        error: null
                    })
                };
            }

            if (table === 'projects') {
                return {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    order: jest.fn().mockResolvedValue({
                        data: projectData,
                        error: null
                    })
                };
            }
        });

        await expect(
            designerController.designer('designer-123')
        ).rejects.toThrow('Unable to retrieve designer profile');

    });

});
