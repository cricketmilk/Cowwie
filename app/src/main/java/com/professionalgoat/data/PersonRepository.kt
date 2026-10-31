package com.professionalgoat.data

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
    /** Job title or role: "RN, ICU", "Recruiter", "Candidate". Free text. */
    val role: String = "",
    /** Department or unit. Free text. */
    val dept: String = "",
    /** Anything worth remembering next time: "starts Nov 3", "asked about PTO". */
    val note: String = "",
) {
    /** One line under the name: role · dept, whichever is present. */
    val subtitle: String get() = listOf(role, dept).filter { it.isNotBlank() }.joinToString(" · ")
}

/**
 * Photo+name pairs captured from the People screen, with the small HR facts
 * that make a face useful a week later. Photos live in the app's private files
 * dir; the index is a small JSON file. Everything stays on-device.
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
                    role = obj.optString("role", ""),
                    dept = obj.optString("dept", ""),
                    note = obj.optString("note", ""),
                )
            }.sortedByDescending { it.createdAt }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun find(id: String?): Person? = id?.let { load().find { p -> p.id == it } }

    fun add(name: String, photoFile: File): Person {
        val person = Person(UUID.randomUUID().toString(), name, photoFile, System.currentTimeMillis())
        save(load() + person)
        return person
    }

    fun rename(id: String, newName: String) {
        save(load().map { if (it.id == id) it.copy(name = newName) else it })
    }

    fun updateDetails(id: String, role: String, dept: String, note: String) {
        save(load().map {
            if (it.id == id) it.copy(role = role.trim(), dept = dept.trim(), note = note.trim()) else it
        })
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
                    .put("role", p.role)
                    .put("dept", p.dept)
                    .put("note", p.note)
            )
        }
        indexFile.writeText(array.toString())
    }
}
