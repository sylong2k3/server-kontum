require('dotenv').config({ quiet: true });

const DEFAULT_ALLOWED_PARAMS = new Set([
    'service', 'version', 'request', 'layers', 'query_layers', 'bbox', 'width', 'height',
    'srs', 'crs', 'format', 'styles', 'transparent', 'i', 'j', 'typename', 'typeName',
    'outputformat', 'outputFormat', 'cql_filter', 'maxfeatures', 'maxFeatures', 'time', 'TIME',
    'info_format', 'feature_count', 'exceptions', 'srsName',
]);

const geoserverConfig = {
    url: process.env.GEOSERVER_URL,
    user: process.env.GEOSERVER_USER,
    password: process.env.GEOSERVER_PASSWORD,
    workspace: process.env.GEOSERVER_WORKSPACE || 'kontum',
    namespaceUri: process.env.GEOSERVER_NAMESPACE_URI || 'https://gis.kontum.gov.vn/kontum',
    datastore: process.env.GEOSERVER_DATASTORE || 'kontum_postgis',
    allowedParams: DEFAULT_ALLOWED_PARAMS,
};

const assertGeoserverConfigured = () => {
    const missing = ['url', 'user', 'password'].filter((key) => !geoserverConfig[key]);
    if (missing.length) {
        throw new Error(`GeoServer is not configured. Missing: ${missing.join(', ')}`);
    }
    return geoserverConfig;
};

module.exports = {
    DEFAULT_ALLOWED_PARAMS,
    assertGeoserverConfigured,
    geoserverConfig,
};
