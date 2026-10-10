# Static-site image for the Anthropic OSS Scanner offline audit.
FROM nginx:alpine
COPY index.html promo-poster.jpg curavia-promo.mp4 /usr/share/nginx/html/
EXPOSE 80
