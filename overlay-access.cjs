// Only for the read-only timer endpoint; server separately validates Host and binds loopback.
function allowOverlayRead(headers, localOrigins) {
 return (headers.origin === undefined || localOrigins.includes(headers.origin)) && [undefined, 'none', 'same-origin'].includes(headers['sec-fetch-site']);
}
module.exports={allowOverlayRead};
