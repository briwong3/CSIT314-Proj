import logging

from app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")  # admin actions show in the terminal
app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
