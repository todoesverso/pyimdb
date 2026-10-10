import os
import sqlite3
import tempfile
import unittest

import app as webapp


class AppTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.temp_dir.name, "test.db")
        connection = sqlite3.connect(cls.db_path)
        connection.executescript(
            """
            CREATE TABLE titles (
                title_id TEXT PRIMARY KEY,
                type TEXT,
                primary_title TEXT,
                original_title TEXT,
                is_adult INTEGER,
                premiered INTEGER,
                ended INTEGER,
                runtime_minutes INTEGER,
                genres TEXT
            );
            CREATE TABLE ratings (
                title_id TEXT PRIMARY KEY,
                rating REAL,
                votes INTEGER
            );
            CREATE TABLE people (
                person_id TEXT PRIMARY KEY,
                name TEXT,
                born INTEGER,
                died INTEGER
            );
            CREATE TABLE crew (
                title_id TEXT,
                person_id TEXT,
                category TEXT,
                job TEXT,
                characters TEXT
            );
            CREATE VIRTUAL TABLE title_fts USING fts5(
                primary_title, title_id UNINDEXED, votes UNINDEXED
            );

            INSERT INTO titles VALUES
                ('tt0000001', 'movie', 'Example Matrix', 'Matrix Example', 0,
                 2000, NULL, 120, 'Action,Sci-Fi');
            INSERT INTO ratings VALUES ('tt0000001', 8.5, 250000);
            INSERT INTO people VALUES ('nm0000001', 'Test Director', 1970, NULL);
            INSERT INTO crew VALUES
                ('tt0000001', 'nm0000001', 'director', NULL, NULL);
            INSERT INTO title_fts VALUES ('Example Matrix', 'tt0000001', 250000);
            """
        )
        connection.commit()
        connection.close()

        cls.original_db_path = webapp.DB_PATH
        cls.original_testing = webapp.app.config.get("TESTING")
        cls.original_rate_limit = webapp.app.config.get("RATELIMIT_ENABLED")
        webapp.DB_PATH = cls.db_path
        webapp.app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
        cls.client = webapp.app.test_client()

    @classmethod
    def tearDownClass(cls):
        webapp.DB_PATH = cls.original_db_path
        webapp.app.config["TESTING"] = cls.original_testing
        webapp.app.config["RATELIMIT_ENABLED"] = cls.original_rate_limit
        cls.temp_dir.cleanup()

    def test_search_returns_matching_title(self):
        response = self.client.get("/api/search?q=matrix")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json[0]["title_id"], "tt0000001")
        self.assertEqual(response.json[0]["primary_title"], "Example Matrix")

    def test_search_with_no_tokens_returns_empty_list(self):
        response = self.client.get("/api/search?q=!!!")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, [])

    def test_title_and_person_detail_routes(self):
        title_response = self.client.get("/api/title/tt0000001")
        person_response = self.client.get("/api/person/nm0000001")

        self.assertEqual(title_response.status_code, 200)
        self.assertEqual(title_response.json["cast"][0]["name"], "Test Director")
        self.assertEqual(person_response.status_code, 200)
        self.assertEqual(person_response.json["titles"][0]["title_id"], "tt0000001")

    def test_sql_endpoint_allows_select_and_rejects_delete(self):
        select_response = self.client.post(
            "/api/query", json={"sql": "SELECT COUNT(*) AS total FROM titles"}
        )
        delete_response = self.client.post(
            "/api/query", json={"sql": "DELETE FROM titles"}
        )

        self.assertEqual(select_response.status_code, 200)
        self.assertEqual(select_response.json["rows"], [[1]])
        self.assertEqual(delete_response.status_code, 400)
        self.assertIn("not authorized", delete_response.json["error"])

    def test_sql_endpoint_caps_rows_and_cell_length(self):
        rows = webapp.run_user_query(
            "WITH RECURSIVE n(value) AS ("
            "SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 501) "
            "SELECT printf('%0400d', value) AS value FROM n"
        )

        self.assertEqual(len(rows["rows"]), webapp.MAX_ROWS)
        self.assertTrue(rows["truncated"])
        self.assertEqual(len(rows["rows"][0][0]), webapp.MAX_CELL + 1)

    def test_sql_endpoint_rejects_empty_and_oversized_queries(self):
        empty_response = self.client.post("/api/query", json={"sql": "  "})
        long_response = self.client.post(
            "/api/query", json={"sql": " " * (webapp.MAX_SQL_LEN + 1)}
        )

        self.assertEqual(empty_response.status_code, 400)
        self.assertEqual(long_response.status_code, 400)


if __name__ == "__main__":
    unittest.main()