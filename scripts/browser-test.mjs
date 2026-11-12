/** Keep automated UI checks from opening download handlers or playing host sounds. */
export async function quietTestPage(page) {
  let blocked = 0;
  await page.route('**/*', route => {
    const request = route.request();
    if (request.resourceType() === 'media' || /\.(?:mp3|wav|ogg|m4a|mp4|webm|zip|tgz|exe|msi)(?:[?#]|$)/i.test(request.url())) {
      blocked++;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  return () => blocked;
}
