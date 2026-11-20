"""World projection shared by the bake scripts.
World frame (same as src/cesium.js): local East-North-Up tangent plane at the KSFO origin.
x = east (m), z = south (m) (north = -z), y = metres above mean sea level."""
import numpy as np
from pyproj import Transformer
LON0, LAT0 = -122.3790, 37.6213
_a = 6378137.0; _f = 1 / 298.257223563; _e2 = _f * (2 - _f)
def _ecef(lat, lon, h=0.0):
    lat = np.radians(lat); lon = np.radians(lon)
    N = _a / np.sqrt(1 - _e2 * np.sin(lat) ** 2)
    return ((N + h) * np.cos(lat) * np.cos(lon), (N + h) * np.cos(lat) * np.sin(lon), (N * (1 - _e2) + h) * np.sin(lat))
_O = np.array(_ecef(LAT0, LON0))
_la, _lo = np.radians(LAT0), np.radians(LON0)
_E = np.array([-np.sin(_lo), np.cos(_lo), 0])
_N = np.array([-np.sin(_la) * np.cos(_lo), -np.sin(_la) * np.sin(_lo), np.cos(_la)])
_U = np.array([np.cos(_la) * np.cos(_lo), np.cos(_la) * np.sin(_lo), np.sin(_la)])
def ll2w(lat, lon):
    """lat/lon (deg) -> world x (east), z (south)"""
    X, Y, Z = _ecef(np.asarray(lat, float), np.asarray(lon, float))
    d = np.stack([X - _O[0], Y - _O[1], Z - _O[2]], -1)
    return d @ _E, -(d @ _N)
_t = Transformer.from_crs('EPSG:4978', 'EPSG:4979', always_xy=True)
def w2ll(x, z):
    """world x,z -> lat, lon (deg); tangent-plane point projected onto the ellipsoid (like Cesium)"""
    x = np.asarray(x, float); z = np.asarray(z, float)
    P = _O[None] + x[..., None] * _E + (-z)[..., None] * _N
    lon, lat, _ = _t.transform(P[..., 0], P[..., 1], P[..., 2])
    return lat, lon
