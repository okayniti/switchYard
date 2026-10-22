# WordPress + wp-cli. Everything the store needs is baked in; nothing is downloaded at runtime.
FROM wordpress:7.1.3-php8.3-apache@sha256:d42f63cb89ad0eab272c4b393164e63830d0df270009907919f7dcce52b1a20b

ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832

# wp-cli is used by the setup Job (install core, activate WooCommerce, seed data).
RUN set -eux; \
    curl -fsSL -o /usr/local/bin/wp \
      "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    echo "${WP_CLI_SHA512}  /usr/local/bin/wp" | sha512sum -c -; \
    chmod +x /usr/local/bin/wp; \
    wp --allow-root --version

# Pinned WooCommerce, verified by checksum. The setup Job installs it from this local
# file (wp plugin install --force), so a WooCommerce bump = new image + helm upgrade,
# even when the WordPress PVC already holds an older copy.
ARG WOOCOMMERCE_VERSION=11.2.1
ADD --checksum=sha256:5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586 \
    https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip \
    /usr/src/woocommerce.zip
RUN chmod 0644 /usr/src/woocommerce.zip
