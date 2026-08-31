package com.cowwie.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class Person(
    val id: String,
    val name: String,
    val photoFile: File,
    val createdAt: Long,
)

/**
 * Photo+name pairs captured from the People screen. Photos live in the app's
 * private files dir; the index is a small JSON file. Everything stays on-device.
 */
class PersonRepository(private val context: Context) {

    private val photosDir = File(context.filesDir, "people").apply { mkdirs() }
    private val indexFile = File(context.filesDir, "people.json")

    fun load(): List<Person> {
        if (!indexFile.exists()) return emptyList()
        return try {
            val array = JSONArray(indexFile.readText())
            (0 until array.length()).mapNotNull { i ->
                val obj = array.getJSONObject(i)
                val photo = File(obj.getString("photo"))
                if (!photo.exists()) null
                else Person(
                    id = obj.getString("id"),
                    name = obj.getString("name"),
                    photoFile = photo,
                    createdAt = obj.optLong("createdAt"),
                )
            }.sortedByDescending { it.createdAt }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun add(name: String, photoFile: File): Person {
        val person = Person(UUID.randomUUID().toString(), name, photoFile, System.currentTimeMillis())
        save(load() + person)
        return person
    }

    fun rename(id: String, newName: String) {
        save(load().map { if (it.id == id) it.copy(name = newName) else it })
    }

    fun delete(id: String) {
        val people = load()
        people.find { it.id == id }?.photoFile?.delete()
        save(people.filterNot { it.id == id })
    }

    /** Fresh destination file for the camera to write into. */
    fun newPhotoFile(): File = File(photosDir, "${UUID.randomUUID()}.jpg")

    private fun save(people: List<Person>) {
        val array = JSONArray()
        people.forEach { p ->
            array.put(
                JSONObject()
                    .put("id", p.id)
                    .put("name", p.name)
                    .put("photo", p.photoFile.absolutePath)
                    .put("createdAt", p.createdAt)
            )
        }
        indexFile.writeText(array.toString())
    }
}
