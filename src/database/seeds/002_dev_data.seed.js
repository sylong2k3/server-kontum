require('dotenv').config();
const db = require('../../configs/database');

(async () => {
    try {
        console.log('=== KHỞI TẠO SEED DỮ LIỆU ĐỂ DEV (NEWS, DOCUMENTS, FEEDBACK, NOTIFICATIONS) ===');

        // 1. Lấy thông tin các user mặc định
        const userRes = await db.query(`
            SELECT u.id, u.email, r.code as role_code 
            FROM auth.users u
            JOIN auth.roles r ON u.role_id = r.id
            WHERE u.deleted_at IS NULL
        `);

        const users = userRes.rows;
        if (users.length === 0) {
            console.error('❌ Không tìm thấy user mặc định nào trong database.');
            console.error('👉 Vui lòng chạy lệnh seed user trước: node src/database/seeds/001_users.seed.js');
            process.exit(1);
        }

        const adminUser = users.find(u => u.role_code === 'system_admin');
        const ubndUser = users.find(u => u.role_code === 'ubnd_tinh');
        const sonnUser = users.find(u => u.role_code === 'so_nnmt');
        const citizenUser = users.find(u => u.role_code === 'citizen');

        if (!adminUser || !ubndUser || !sonnUser || !citizenUser) {
            console.warn('⚠ Cảnh báo: Thiếu một số vai trò mặc định (system_admin, ubnd_tinh, so_nnmt, citizen) trong database.');
        }

        // Dùng user có sẵn làm dự phòng nếu thiếu
        const authorAdmin = adminUser?.id || users[0].id;
        const authorSonn = sonnUser?.id || users[0].id;
        const authorUbnd = ubndUser?.id || users[0].id;
        const authorCitizen = citizenUser?.id || users[0].id;

        console.log('✓ Xác định tác giả thành công:');
        console.log(`  - Admin ID: ${authorAdmin}`);
        console.log(`  - Sở NN&MT ID: ${authorSonn}`);
        console.log(`  - UBND Tỉnh ID: ${authorUbnd}`);
        console.log(`  - Người dân ID: ${authorCitizen}`);

        // 2. Làm sạch dữ liệu cũ để tránh trùng lặp
        console.log('\n🧹 Đang làm sạch dữ liệu cũ...');
        await db.query('TRUNCATE TABLE field.feedback_status_log, field.feedback, cms.news_translations, cms.news, cms.document_translations, cms.documents, core.notification_reads, core.notifications RESTART IDENTITY CASCADE');
        console.log('✓ Đã làm sạch các bảng news, documents, feedback, notifications.');

        // 3. Seed News (Tin tức)
        console.log('\n📰 Đang seed dữ liệu Tin tức (cms.news & cms.news_translations)...');
        const newsItems = [
            {
                cover_url: 'https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?auto=format&fit=crop&w=800&q=80',
                status: 'published',
                author_id: authorAdmin,
                published_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 tiếng trước
                translations: [
                    {
                        lang: 'vi',
                        title: 'Khởi động dự án nâng cấp hệ thống Giám sát Tài nguyên Rừng tỉnh Kon Tum',
                        slug: 'khoi-dong-du-an-nang-cap-he-thong-giam-sat-tai-nguyen-rung-tinh-kon-tum',
                        summary: 'Dự án ứng dụng công nghệ GIS và ảnh vệ tinh để theo dõi biến động diện tích rừng tự nhiên thời gian thực.',
                        content: 'Ủy ban Nhân dân tỉnh Kon Tum phối hợp cùng Sở Nông nghiệp và Phát triển Nông thôn chính thức công bố dự án nâng cấp phần mềm GIS chuyên ngành lâm nghiệp. Hệ thống mới sẽ tích hợp dữ liệu từ Google Earth Engine để tự động cảnh báo điểm cháy rừng và phát hiện phá rừng sớm.'
                    },
                    {
                        lang: 'en',
                        title: 'Launching the Project to Upgrade Forest Resource Monitoring System in Kon Tum',
                        slug: 'launching-the-project-to-upgrade-forest-resource-monitoring-system-in-kon-tum',
                        summary: 'The project applies GIS technology and satellite imagery to track natural forest changes in real-time.',
                        content: 'Kon Tum Provincial People\'s Committee, in collaboration with the Department of Agriculture and Rural Development, officially announced the upgrade project of forestry GIS software. The new system will integrate Google Earth Engine data to automatically alert forest fire hotspots and detect early deforestation.'
                    }
                ]
            },
            {
                cover_url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=800&q=80',
                status: 'published',
                author_id: authorSonn,
                published_at: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 ngày trước
                translations: [
                    {
                        lang: 'vi',
                        title: 'Kon Tum tăng cường tuần tra biên giới bảo vệ rừng đặc dụng Chư Mom Ray',
                        slug: 'kon-tum-tang-cuong-tuan-tra-bien-gioi-bao-ve-rung-dac-dung-chu-mom-ray',
                        summary: 'Lực lượng kiểm lâm phối hợp với bộ đội biên phòng tuần tra các khu vực trọng điểm có nguy cơ khai thác lâm sản trái phép.',
                        content: 'Nhằm bảo vệ hệ sinh thái đa dạng sinh học tại Vườn quốc gia Chư Mom Ray, Ban Quản lý đã tăng cường nhân sự cắm chốt tại các trạm kiểm lâm cửa ngõ. Đồng thời sử dụng thiết bị bay không người lái (UAV) để kiểm tra các khu vực hiểm trở khó tiếp cận bằng đường bộ.'
                    }
                ]
            },
            {
                cover_url: 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&w=800&q=80',
                status: 'draft',
                author_id: authorAdmin,
                published_at: null,
                translations: [
                    {
                        lang: 'vi',
                        title: 'Dự thảo kế hoạch hành động thích ứng với biến đổi khí hậu giai đoạn 2026-2030',
                        slug: 'du-thao-ke-hoach-hanh-dong-thich-ung-voi-bien-doi-khi-hau-giai-doan-2026-2030',
                        summary: 'Tập trung vào phát triển nông nghiệp bền vững, quản lý nguồn nước và bảo vệ diện tích rừng phòng hộ đầu nguồn.',
                        content: 'Dự thảo đang được lấy ý kiến từ các sở, ban, ngành và người dân trên địa bàn tỉnh Kon Tum. Mục tiêu giảm phát thải carbon, phủ xanh đất trống đồi trọc và nâng cao sinh kế cho đồng bào dân tộc thiểu số gắn liền với giữ rừng.'
                    }
                ]
            }
        ];

        for (const item of newsItems) {
            const newsRes = await db.query(
                `INSERT INTO cms.news (cover_url, status, author_id, published_at)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [item.cover_url, item.status, item.author_id, item.published_at]
            );
            const newsId = newsRes.rows[0].id;

            for (const trans of item.translations) {
                await db.query(
                    `INSERT INTO cms.news_translations (news_id, lang, title, slug, summary, content)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [newsId, trans.lang, trans.title, trans.slug, trans.summary, trans.content]
                );
            }
            console.log(`  ✓ Đã seed tin tức: "${item.translations[0].title}"`);
        }

        // 4. Seed Documents (Tài liệu/Bản đồ)
        console.log('\n📁 Đang seed dữ liệu Tài liệu (cms.documents & cms.document_translations)...');
        const documentItems = [
            {
                doc_type: 'van_ban',
                file_url: '/uploads/documents/quy-hoach-bao-ve-rung-2030.pdf',
                file_name: 'QuyetDinh_QuyHoachRung_KonTum.pdf',
                mime_type: 'application/pdf',
                file_size: 2450800,
                is_public: true,
                uploaded_by: authorAdmin,
                translations: [
                    {
                        lang: 'vi',
                        title: 'Quyết định phê duyệt Quy hoạch bảo vệ và phát triển rừng tỉnh Kon Tum giai đoạn 2025 - 2030',
                        description: 'Văn bản pháp lý quy định chi tiết về ranh giới các loại rừng, mục tiêu độ che phủ rừng và ngân sách đầu tư lâm nghiệp.'
                    }
                ]
            },
            {
                doc_type: 'pdf_map',
                file_url: '/uploads/documents/ban-do-nguy-co-chay-rung-2026.pdf',
                file_name: 'BanDo_PhanVungChayRung_2026.pdf',
                mime_type: 'application/pdf',
                file_size: 5120000,
                is_public: true,
                uploaded_by: authorSonn,
                translations: [
                    {
                        lang: 'vi',
                        title: 'Bản đồ phân vùng nguy cơ cháy rừng tỉnh Kon Tum năm 2026',
                        description: 'Bản đồ chuyên đề GIS phân vùng các cấp độ nguy cơ cháy rừng theo mùa khô tại các huyện Đăk Tô, Sa Thầy, Kon Plông.'
                    }
                ]
            },
            {
                doc_type: 'bao_cao',
                file_url: '/uploads/documents/bao-cao-q1-2026-ubnd.pdf',
                file_name: 'BC_KQXH_Q1_2026.pdf',
                mime_type: 'application/pdf',
                file_size: 1845000,
                is_public: false,
                uploaded_by: authorUbnd,
                translations: [
                    {
                        lang: 'vi',
                        title: 'Báo cáo tổng kết tình hình kinh tế - xã hội và tài nguyên môi trường Quý 1/2026',
                        description: 'Báo cáo định kỳ của UBND tỉnh trình Hội đồng nhân dân tỉnh về chỉ số lâm nghiệp, công nghiệp và môi trường.'
                    }
                ]
            }
        ];

        for (const item of documentItems) {
            const docRes = await db.query(
                `INSERT INTO cms.documents (doc_type, file_url, file_name, mime_type, file_size, is_public, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [item.doc_type, item.file_url, item.file_name, item.mime_type, item.file_size, item.is_public, item.uploaded_by]
            );
            const docId = docRes.rows[0].id;

            for (const trans of item.translations) {
                await db.query(
                    `INSERT INTO cms.document_translations (document_id, lang, title, description)
                     VALUES ($1, $2, $3, $4)`,
                    [docId, trans.lang, trans.title, trans.description]
                );
            }
            console.log(`  ✓ Đã seed tài liệu: "${item.translations[0].title}"`);
        }

        // 5. Seed Feedback (Phản ánh hiện trường)
        console.log('\n💬 Đang seed dữ liệu Phản ánh hiện trường (field.feedback & field.feedback_status_log)...');
        const feedbackItems = [
            {
                user_id: authorCitizen,
                category: 'hien_trang',
                title: 'Phát hiện vết sạt lở đất đe dọa đường tuần tra gần trạm kiểm lâm Đăk Rơ Nga',
                description: 'Vết sạt lở rộng khoảng 5m sau đợt mưa lớn tuần trước, đất đá tràn xuống đường làm cản trở xe tuần tra của trạm kiểm lâm. Cần có xe xúc dọn dẹp sớm.',
                status: 'resolved',
                priority: 'high',
                media_urls: JSON.stringify(['/uploads/feedback/sat-lo-1.jpg', '/uploads/feedback/sat-lo-2.jpg']),
                lng: 107.95,
                lat: 14.65,
                created_by: authorCitizen,
                updated_by: authorSonn,
                resolved_at: new Date(Date.now() - 3 * 3600 * 1000),
                logs: [
                    { from_status: null, to_status: 'new', note: 'Người dân gửi phản ánh sạt lở đường tuần tra.', changed_by: authorCitizen },
                    { from_status: 'new', to_status: 'in_progress', note: 'Sở NN&MT tiếp nhận, chuyển hạt kiểm lâm Đăk Tô xác minh thực tế.', changed_by: authorSonn },
                    { from_status: 'in_progress', to_status: 'resolved', note: 'Đã cử xe xúc dọn sạch đất đá, thông đường tuần tra lâm nghiệp.', changed_by: authorSonn }
                ]
            },
            {
                user_id: authorCitizen,
                category: 'vi_pham',
                title: 'Nghi ngờ có nhóm người đang dựng lán trại khai thác gỗ trái phép',
                description: 'Tại tiểu khu 245 thuộc xã Măng Cành, huyện Kon Plông, tôi nghe tiếng cưa máy và phát hiện có lán trại mới dựng cùng nhiều gỗ xẻ xếp sẵn.',
                status: 'in_progress',
                priority: 'urgent',
                media_urls: JSON.stringify(['/uploads/feedback/go-lam-tac.jpg']),
                lng: 108.25,
                lat: 14.52,
                created_by: authorCitizen,
                updated_by: authorUbnd,
                resolved_at: null,
                logs: [
                    { from_status: null, to_status: 'new', note: 'Người dân phản ánh hành vi nghi phá rừng.', changed_by: authorCitizen },
                    { from_status: 'new', to_status: 'in_progress', note: 'UBND tỉnh chỉ đạo Hạt Kiểm lâm Kon Plông lập tổ liên ngành vào hiện trường xác minh xử lý gấp.', changed_by: authorUbnd }
                ]
            },
            {
                user_id: authorSonn,
                category: 'chay_rung',
                title: 'Báo cáo cháy thực bì nông nghiệp gần bìa rừng phòng hộ Sa Thầy',
                description: 'Người dân đốt dọn rẫy nông nghiệp khói lớn sát bìa rừng phòng hộ đầu nguồn Sa Thầy, gió to dễ bén vào rừng. Đang cử kiểm lâm viên cơ sở xuống hướng dẫn khống chế.',
                status: 'new',
                priority: 'high',
                media_urls: JSON.stringify([]),
                lng: 107.75,
                lat: 14.42,
                created_by: authorSonn,
                updated_by: null,
                resolved_at: null,
                logs: [
                    { from_status: null, to_status: 'new', note: 'Khởi tạo phản ánh cháy thực bì từ hiện trường tuần tra.', changed_by: authorSonn }
                ]
            }
        ];

        for (const item of feedbackItems) {
            const fbRes = await db.query(
                `INSERT INTO field.feedback (
                    user_id, category, title, description, status, priority, 
                    media_urls, lng, lat, created_by, updated_by, resolved_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                [
                    item.user_id, item.category, item.title, item.description, item.status, item.priority,
                    item.media_urls, item.lng, item.lat, item.created_by, item.updated_by, item.resolved_at
                ]
            );
            const fbId = fbRes.rows[0].id;

            for (const log of item.logs) {
                await db.query(
                    `INSERT INTO field.feedback_status_log (feedback_id, from_status, to_status, note, changed_by)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [fbId, log.from_status, log.to_status, log.note, log.changed_by]
                );
            }
            console.log(`  ✓ Đã seed phản ánh: "${item.title}"`);
        }

        // 6. Seed Notifications (Thông báo)
        console.log('\n🔔 Đang seed dữ liệu Thông báo (core.notifications)...');
        const notificationItems = [
            {
                user_id: null,
                audience: 'all',
                audience_role: null,
                channel: 'system',
                type: 'system_alert',
                title: 'Cập nhật ứng dụng GIS Kon Tum phiên bản v1.2.0',
                body: 'Hệ thống đã cập nhật tính năng mới: Xem bản đồ nhiệt cảnh báo cháy rừng từ dữ liệu vệ tinh Sentinel-2. Vui lòng tải lại trang để trải nghiệm.',
                data: JSON.stringify({ version: '1.2.0' })
            },
            {
                user_id: null,
                audience: 'role',
                audience_role: 'so_nnmt',
                channel: 'fire',
                type: 'fire_danger_alert',
                title: 'Cảnh báo cháy rừng cấp cực kỳ nguy hiểm (Cấp V)',
                body: 'Khu vực huyện Kon Plông và Sa Thầy đang có nhiệt độ cao kéo dài kết hợp độ ẩm thấp. Đề nghị các trạm kiểm lâm tăng cường ứng trực 24/24.',
                data: JSON.stringify({ level: 'V', regions: ['Kon Plông', 'Sa Thầy'] })
            },
            {
                user_id: authorCitizen,
                audience: 'user',
                audience_role: null,
                channel: 'field',
                type: 'feedback_resolved',
                title: 'Phản ánh hiện trạng sạt lở của bạn đã được xử lý',
                body: 'Cảm ơn bạn đã phản ánh. Hạt kiểm lâm Đăk Tô đã tiến hành xử lý sạt lở và thông tuyến đường tuần tra Đăk Rơ Nga.',
                data: JSON.stringify({ feedbackId: 1 })
            },
            {
                user_id: authorAdmin,
                audience: 'user',
                audience_role: null,
                channel: 'system',
                type: 'backup_success',
                title: 'Sao lưu dữ liệu hệ thống thành công',
                body: 'Bản sao lưu cơ sở dữ liệu hàng tuần đã được tải lên lưu trữ an toàn lúc 02:00 sáng.',
                data: JSON.stringify({ backupId: 'db_backup_20260619' })
            }
        ];

        for (const item of notificationItems) {
            await db.query(
                `INSERT INTO core.notifications (user_id, audience, audience_role, channel, type, title, body, data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    item.user_id, item.audience, item.audience_role, item.channel, item.type,
                    item.title, item.body, item.data
                ]
            );
            console.log(`  ✓ Đã seed thông báo: "${item.title}"`);
        }

        console.log('\n🎉 ĐÃ KHỞI TẠO SEED DỮ LIỆU THÀNH CÔNG!');
        await db.pool.end();
        process.exit(0);
    } catch (e) {
        console.error('❌ SEED DỮ LIỆU THẤT BẠI:', e);
        await db.pool.end().catch(() => {});
        process.exit(1);
    }
})();
