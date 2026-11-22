(() => {
  const section = document.querySelector('[data-werk-routing]');
  if (!section) return;

  const feature = section.querySelector('[data-wr-feature]');
  const plate = section.querySelector('.wr-plate');
  const map = section.querySelector('[data-wr-map]');
  const services = { checkout: 'Checkout', search: 'Search', catalog: 'Catalog' };
  const featureContainers = { 'checkout-retry': 'checkout', 'search-filter': 'search' };

  function updateRouting() {
    const requested = section.querySelector('input[name="wr-service"]:checked').value;
    const localService = featureContainers[feature.value];
    const local = requested === localService;
    const service = services[requested];
    const destination = local ? 'feature container' : 'shared baseline';

    plate.dataset.wrLocal = String(local);
    map.setAttribute('aria-label', service + ' request through Caddy to the ' + destination + '.');
    section.querySelector('[data-wr-request]').textContent = requested;
    section.querySelector('[data-wr-local-name]').textContent = services[localService];
    section.querySelector('[data-wr-base-name]').textContent = service;
    section.querySelector('[data-wr-header]').textContent = 'X-Feature: ' + feature.value;
    section.querySelector('[data-wr-result]').textContent = local
      ? service + ' runs in the ' + feature.value + ' workspace. Its local container handles the request.'
      : 'The ' + feature.value + ' workspace runs ' + services[localService] + '. Caddy forwards this request to the shared ' + service + ' service.';

    plate.classList.remove('wr-traced');
    void plate.offsetWidth;
    plate.classList.add('wr-traced');
  }

  section.addEventListener('change', updateRouting);
  // Browsers can restore form selections when a visitor navigates back to the page.
  updateRouting();
})();
