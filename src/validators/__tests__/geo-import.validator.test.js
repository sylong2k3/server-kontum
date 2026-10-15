'use strict';
const { geoImportPayload } = require('../geo-import.validator');
const base = { code: 'forest-2026', table_name: 'forest_2026', source_format: 'geojson' };
test('legacy import defaults are unchanged', () => {
    const { error, value } = geoImportPayload.validate(base);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ new_layer: false, auto_publish: true, import_mode: 'overwrite', is_active: true });
});
test('converts multipart booleans and preserves canonical style and legend', () => {
    const { error, value } = geoImportPayload.validate({ ...base, new_layer: 'true', is_active: 'false',
        default_style: { fillColor: '#008800' }, legend_config: { entries: [{ label: 'Forest', color: '#008800' }] } });
    expect(error).toBeUndefined();
    expect(value.new_layer).toBe(true);
    expect(value.is_active).toBe(false);
    expect(value.legend_config.entries).toHaveLength(1);
});
test.each([{ table_name: 'forest-2026' }, { legend_config: { entries: [{ label: 'Forest', color: 'not-color' }] } }, { default_style: [] }, { new_layer: 'invalid' }])('rejects invalid import metadata %j', fields => {
    expect(geoImportPayload.validate({ ...base, ...fields }).error).toBeDefined();
});
